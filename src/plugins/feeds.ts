// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import sharp from "sharp";
import { reason } from "../crawl/fetch.ts";
import { RobotsDisallowed } from "../crawl/probe.ts";
import type { Facts, ResourceFacts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { header, linkTargets, pageRule, resolve } from "../rules/builtin.ts";
import type { Finding, Make } from "../rules/types.ts";
import { judgeContent, judgeTitle, wordsOf } from "./feed-content.ts";
import { NS, readJson, readXml, type Dated, type Format, type Model } from "./feed-model.ts";
import { definePlugin, type SiteExtractor } from "./types.ts";

const ID = "feed";
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/feed+json"]);
const WRONG_TYPES = new Set(["text/html", "text/plain", "application/octet-stream", ""]);
const XML_ROOT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<\?xml-stylesheet[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<\?xml-stylesheet[^>]*>\s*)?<(?:rss|feed|rdf:RDF)[\s>]/;
const TRACKING = /^(?:utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok)$/i;
const PROBLEM_CAP = 50;
const DAY_MS = 86_400_000;
const PODCAST_NAMESPACE = "ead4c236-bf58-58c6-a2c6-a6b28d128cb6";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const RFC822 = /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|UT|GMT|[ECMP][SD]T|Z)$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const ZONES: Record<string, string> = { UT: "+0000", GMT: "+0000", Z: "+0000", EST: "-0500", EDT: "-0400", CST: "-0600", CDT: "-0500", MST: "-0700", MDT: "-0600", PST: "-0800", PDT: "-0700" };
const DURATION = /^(?:\d+|\d{1,2}:\d{2}(?::\d{2})?)$/;
const XSL_TYPES = new Set(["text/xsl", "application/xslt+xml", "application/xml", "text/xml"]);
const FORMAT_TYPES: Record<string, Format> = { "application/rss+xml": "rss", "application/rdf+xml": "rss", "application/atom+xml": "atom", "application/feed+json": "json" };

export interface FeedEntry {
    position: number;
    id?: string;
    // The item’s link with tracking parameters removed.
    link?: string;
    title?: string;
    published?: string;
    // Visible words across the item’s content fields.
    words?: number;
}

// One enclosure the feed declares, its URL resolved and its `length` and `type` as written.
export interface FeedEnclosure {
    url: string;
    length?: string;
    type?: string;
    position: number;
}

export interface FeedFacts {
    format: Format;
    error?: string;
    self?: string;
    hubs: string[];
    items: number;
    // 1-based positions of the items carrying no `guid`, `id` or `rdf:about`.
    unidentified: number[];
    language?: string;
    updated?: string;
    ttl?: number;
    stylesheet?: string;
    archives?: Record<string, string>;
    podcast?: true;
    entries?: FeedEntry[];
    // Every enclosure the feed declares, its URL resolved.
    enclosures?: FeedEnclosure[];
    // The channel `itunes:image`, resolved; the `<podcast:locked>` value, when named.
    itunesImage?: string;
    locked?: string;
    // Spec and content problems by rule name, each one location line.
    problems?: Record<string, string[]>;
}

interface FeedsSettings {
    "stale-days": number;
    "max-bytes": number;
    websub: boolean;
}

// A URL with its tracking query parameters removed; anything unparsable stays as written.
export function untracked(raw: string, base: string): string {
    const href = resolve(raw, base);
    if (!URL.canParse(href)) return href;
    const url = new URL(href);
    const tracking = url.searchParams.keys().filter((name) => TRACKING.test(name)).toArray();
    for (const name of tracking) url.searchParams.delete(name);
    return url.href;
}

// ISO form of an RFC 822 date, undefined when it breaks the grammar or names the wrong weekday.
function rfc822(raw: string): string | undefined {
    const match = RFC822.exec(raw.trim());
    if (!match) return undefined;
    const [, day, date, month, year, hours, minutes, seconds = "00", zone = ""] = match;
    const offset = ZONES[zone] ?? zone;
    const calendar = new Date(Date.UTC(Number(year), MONTHS.indexOf(month as string), Number(date)));
    if (calendar.getUTCDate() !== Number(date) || (day && DAYS[calendar.getUTCDay()] !== day)) return undefined;
    const time = Date.parse(`${calendar.toISOString().slice(0, 10)}T${hours}:${minutes}:${seconds}${offset.slice(0, 3)}:${offset.slice(3)}`);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

// ISO form of a feed date in its format’s grammar: RFC 822 in RSS, RFC 3339 in Atom and JSON Feed.
function isoOf(format: Format, date: Dated): string | undefined {
    if (format === "rss" && date.field === "dc:date") return RFC3339.test(date.raw) || /^\d{4}-\d{2}-\d{2}$/.test(date.raw) ? new Date(date.raw).toISOString() : undefined;
    if (format === "rss") return rfc822(date.raw);
    return RFC3339.test(date.raw) && !Number.isNaN(Date.parse(date.raw)) ? new Date(date.raw).toISOString() : undefined;
}

// Whether a value is a well-formed BCP 47 tag.
function isLanguage(tag: string): boolean {
    try {
        return Intl.getCanonicalLocales(tag).length === 1;
    } catch {
        return false;
    }
}

// The UUIDv5 Podcasting 2.0 derives from a feed URL without its scheme and trailing slashes.
export function podcastGuid(feedUrl: string): string {
    const name = feedUrl.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
    const hash = createHash("sha1").update(Buffer.from(PODCAST_NAMESPACE.replaceAll("-", ""), "hex")).update(name).digest();
    hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
    hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Problem lists filled one location at a time, each capped.
class Problems {
    readonly lists: Record<string, string[]> = {};
    add(rule: string, location: string): void {
        const list = (this.lists[rule] ??= []);
        if (list.length < PROBLEM_CAP && !list.includes(location)) list.push(location);
    }
}

// The feed format a page’s type or root element announces.
function formatOf(page: Facts, body: string): Format | undefined {
    const type = page.http["content-type"];
    if (type === "application/feed+json" || ((type === "application/json" || WRONG_TYPES.has(type)) && /"version"\s*:\s*"https:\/\/jsonfeed\.org\/version\//.test(body.slice(0, 4096)))) return "json";
    if (!FEED_TYPES.has(type) && !((/[/+]xml$/.test(type) || WRONG_TYPES.has(type)) && XML_ROOT.test(body))) return undefined;
    return type === "application/atom+xml" || /<feed[\s>]/.test(body.slice(0, 4096)) ? "atom" : "rss";
}

// Spec conformance of the channel and every item.
function judgeSpec(model: Model, problems: Problems, base: string): void {
    const where = model.format === "rss" ? "channel" : "feed";
    for (const name of model.missing) problems.add("required", `${where} lacks ${name}`);
    const ids = new Map<string, number>();
    for (const item of model.items) {
        const at = `item ${item.position}`;
        for (const name of item.missing) problems.add("required", `${at} lacks ${name}`);
        if (model.format !== "rss" && !model.hasAuthor && !item.hasAuthor) problems.add("required", `${at} names no author and the feed names none`);
        for (const enclosure of item.enclosures) for (const [name, value] of Object.entries(enclosure)) if (!value && model.format === "rss") problems.add("required", `${at} enclosure lacks ${name}`);
        for (const date of [item.published, item.updated]) if (date && !isoOf(model.format, date)) problems.add("date-format", `${at} ${date.field} “${date.raw}”`);
        if (item.id !== undefined) {
            const first = ids.get(item.id);
            if (first === undefined) {ids.set(item.id, item.position);}
            else {problems.add("duplicate-id", `${at} repeats the id of item ${first}: ${item.id}`);}
            if (URL.canParse(item.id) && new URL(item.id).searchParams.keys().some((name) => TRACKING.test(name))) problems.add("id-tracking", `${at}: ${item.id}`);
        }
        if (item.isPermalink && item.id !== undefined && !/^https?:\/\//i.test(item.id)) problems.add("permalink", `${at} guid “${item.id}”`);
        const urls = [["link", item.link], ...item.enclosures.map((enclosure) => ["enclosure", enclosure.url])] as const;
        if (model.format !== "atom") for (const [field, url] of urls) if (url && !/^[a-z][a-z\d+.-]*:/i.test(url)) problems.add("absolute-url", `${at} ${field} “${url}”`);
        for (const name of item.unknown) problems.add(model.format === "json" ? "json-version" : "unknown-element", model.format === "json" ? `${at} uses author, which 1.1 replaced with authors` : `${at} <${name}>`);
        for (const email of item.emails) if (!/^\S+@\S+\.\S+(?:\s+\(.+\))?$/.test(email.raw)) problems.add("email", `${at} ${email.field} “${email.raw}”`);
        if (item.title !== undefined) for (const problem of judgeTitle(item.title, item.titleType)) problems.add("title-markup", `${at}: ${problem}`);
        for (const content of item.contents) {
            const found = judgeContent(content);
            for (const [rule, samples] of Object.entries(found)) for (const sample of samples) problems.add(rule === "mojibake" ? "charset" : rule, `${at} ${content.field}: ${sample}`);
        }
    }
    if (model.updated && !isoOf(model.format, model.updated)) problems.add("date-format", `${where} ${model.updated.field} “${model.updated.raw}”`);
    if (model.link && model.format !== "atom" && !/^[a-z][a-z\d+.-]*:/i.test(model.link)) problems.add("absolute-url", `${where} link “${model.link}”`);
    if (model.language && !isLanguage(model.language)) problems.add("language", `${where} language “${model.language}”`);
    for (const name of model.unknown) problems.add(model.format === "json" ? "json-version" : "unknown-element", model.format === "json" ? "feed uses author, which 1.1 replaced with authors" : `${where} <${name}>`);
    for (const email of model.emails) if (!/^\S+@\S+\.\S+(?:\s+\(.+\))?$/.test(email.raw)) problems.add("email", `${where} ${email.field} “${email.raw}”`);
    if (model.format === "json" && model.version !== "https://jsonfeed.org/version/1.1") problems.add("json-version", `version ${model.version}`);
    if (model.ttl !== undefined && !/^\d+$/.test(model.ttl)) problems.add("required", `${where} ttl “${model.ttl}” is not a whole number of minutes`);
    if (model.isComplete && (model.archives["prev-archive"] || model.archives["next-archive"])) problems.add("archive", `${where} is complete and still names archive pages`);
    log.debug({ url: base, format: model.format, items: model.items.length, rules: Object.keys(problems.lists) }, "feed judged");
}

// What a podcast directory requires of the channel and its episodes.
function judgePodcast(model: Model, problems: Problems, self: string): void {
    const declared = new Set(Object.entries(model.itunes).flatMap(([name, value]) => (value ? [name] : [])));
    for (const name of ["image", "category", "explicit", "author"]) if (!declared.has(name)) problems.add("itunes-required", `channel lacks itunes:${name}`);
    if (!model.language) problems.add("itunes-required", "channel lacks language");
    for (const item of model.items) for (const duration of item.durations) if (!DURATION.test(duration)) problems.add("itunes-required", `item ${item.position} itunes:duration “${duration}”`);
    const expected = podcastGuid(self);
    if (!model.podcastGuid) problems.add("podcast-guid", `channel lacks podcast:guid; ${expected} derives from ${self}`);
    else if (model.podcastGuid.toLowerCase() !== expected) problems.add("podcast-guid", `podcast:guid ${model.podcastGuid} is not ${expected}, the UUIDv5 of ${self}`);
    log.debug({ url: self, itunes: Object.keys(model.itunes), guid: model.podcastGuid, expected }, "podcast judged");
}

// How the page was served: its type and the charset its header and declaration agree on.
function judgeServed(page: Facts, body: string, format: Format, problems: Problems): void {
    const type = page.http["content-type"];
    if (WRONG_TYPES.has(type)) problems.add("media-type", `served as ${type || "no type"}`);
    const declared = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(body)?.[1]?.toLowerCase();
    const sent = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(header(page, "content-type"))?.[1]?.toLowerCase();
    if (format !== "json" && sent && declared && sent.replace("-", "") !== declared.replace("-", "")) problems.add("charset", `Content-Type says ${sent}, the XML declaration ${declared}`);
    if (format === "json" && sent && sent.replace("-", "") !== "utf8") problems.add("charset", `JSON Feed served as ${sent}, not UTF-8`);
}

// Feed facts of an RSS, Atom or JSON Feed page, the `Link` header adding a self or hub the body lacks.
async function extract(page: Facts, body: string): Promise<FeedFacts | undefined> {
    const format = formatOf(page, body);
    if (!format || page.http.size.truncated) {
        log.debug({ url: page.url.href, contentType: page.http["content-type"], format, truncated: page.http.size.truncated === true }, "feed skipped");
        return;
    }
    let model: (Model & { stylesheet?: string }) | undefined;
    try {
        model = format === "json" ? readJson(body, page.url.href) : readXml(body, page.url.href);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug({ url: page.url.href, format, error: message }, "feed unparsable");
        return { format, error: message, hubs: [], items: 0, unidentified: [] };
    }
    if (!model) return;
    const link = header(page, "link");
    const self = model.self ?? linkTargets(link, "self", page.url.href)[0];
    const hubs = model.hubs.length > 0 ? model.hubs : linkTargets(link, "hub", page.url.href);
    const problems = new Problems();
    judgeSpec(model, problems, page.url.href);
    judgeServed(page, body, model.format, problems);
    const isPodcast = model.namespaces.has(NS.itunes) || model.namespaces.has(NS.podcast) || model.items.some((item) => item.enclosures.some((enclosure) => /^(?:audio|video)\//.test(enclosure.type ?? "")));
    if (isPodcast) judgePodcast(model, problems, self ?? page.url.href);
    const entries = model.items.map((item): FeedEntry => {
        const published = (item.published ?? item.updated) && isoOf(model.format, (item.published ?? item.updated) as Dated);
        const words = item.contents.reduce((total, content) => total + wordsOf(content), 0);
        return { position: item.position, ...(item.id && { id: item.id }), ...(item.link && { link: untracked(item.link, page.url.href) }), ...(item.title && { title: item.title }), ...(published && { published }), ...(words > 0 && { words }) };
    });
    const updated = model.updated && isoOf(model.format, model.updated);
    const enclosures = model.items.flatMap((item): FeedEnclosure[] => item.enclosures.flatMap((enclosure) => {
        if (!enclosure.url || !URL.canParse(enclosure.url, page.url.href)) return [];
        const url = new URL(enclosure.url, page.url.href);
        url.hash = "";
        return /^https?:$/.test(url.protocol) ? [{ url: url.href, ...(enclosure.length !== undefined && { length: enclosure.length }), ...(enclosure.type !== undefined && { type: enclosure.type }), position: item.position }] : [];
    }));
    const image = model.itunes.image ? resolve(model.itunes.image, page.url.href) : undefined;
    const itunesImage = image && URL.canParse(image) && /^https?:$/.test(new URL(image).protocol) ? new URL(image).href : undefined;
    log.debug({ url: page.url.href, format, self, hubs: hubs.length, items: model.items.length, isPodcast, problems: Object.keys(problems.lists).length }, "feed read");
    const seen = new Set((page.resources ?? []).map((resource) => `${resource.kind} ${resource.url}`));
    for (const enclosure of enclosures) {
        const key = `enclosure ${enclosure.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const url = new URL(enclosure.url);
        (page.resources ??= []).push({ url: enclosure.url, kind: "enclosure", origin: url.origin === page.url.origin ? "same" : "cross" } satisfies ResourceFacts);
    }
    return {
        format: model.format,
        ...(self && { self }),
        hubs,
        items: model.items.length,
        unidentified: model.items.filter((item) => !item.id?.trim()).map((item) => item.position),
        ...(model.language && { language: model.language }),
        ...(updated && { updated }),
        ...(model.ttl && /^\d+$/.test(model.ttl) && { ttl: Number(model.ttl) }),
        ...(model.stylesheet && { stylesheet: model.stylesheet }),
        ...(Object.keys(model.archives).length > 0 && { archives: model.archives }),
        ...(isPodcast && { podcast: true as const }),
        entries,
        ...(enclosures.length > 0 && { enclosures }),
        ...(itunesImage && { itunesImage }),
        ...(model.locked !== undefined && { locked: model.locked }),
        problems: problems.lists,
    };
}

const feedOf = (page: Facts) => page[ID] as FeedFacts | undefined;
// A feed that parsed, else undefined so its rule skips.
const parsed = (page: Facts) => (feedOf(page)?.error === undefined ? feedOf(page) : undefined);
const DOCS = {
    rss: "https://www.rssboard.org/rss-profile",
    rss2: "https://www.rssboard.org/rss-specification",
    atom: "https://www.rfc-editor.org/rfc/rfc4287",
    json: "https://www.jsonfeed.org/version/1.1/",
    websub: "https://www.w3.org/TR/websub/#discovery",
    archive: "https://www.rfc-editor.org/rfc/rfc5005",
    xslt: "https://chromestatus.com/feature/4709671889534976",
    itunes: "https://podcasters.apple.com/support/823-podcast-requirements",
    podcast: "https://podcasting2.org/docs/podcast-namespace/tags/guid",
    locked: "https://podcasting2.org/docs/podcast-namespace/tags/locked",
    discovery: "https://www.rssboard.org/rss-autodiscovery",
};

const wellFormed = pageRule("feeds/well-formed", [`${ID}.error`], (page) => {
    const feed = feedOf(page);
    return feed && (feed.error ? [{ message: `${feed.format} feed does not parse: ${feed.error}`, value: feed.error }] : []);
}, { docs: "https://www.w3.org/TR/xml/#sec-well-formed", fix: "Serve the feed from an XML or JSON serialiser instead of a text template, so every value is escaped." });

const self = pageRule("feeds/self", [`${ID}.self`], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    if (!feed.self) return [{ message: `${feed.format} feed names no self URL` }];
    const here = [page.url.href, page.url.twin].flatMap((href) => (href ? [resolve(href, href)] : []));
    return here.includes(feed.self) ? [] : [{ message: `${feed.format} feed names ${feed.self} as its self URL, not this one`, value: feed.self }];
}, { docs: DOCS.rss, fix: "Add `<atom:link rel=\"self\">` (RSS), `<link rel=\"self\">` (Atom) or `feed_url` (JSON Feed) naming the feed’s own URL." });

const itemId = pageRule("feeds/item-id", [`${ID}.unidentified`], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    const count = feed.unidentified.length;
    return count === 0 ? [] : [{ message: `${count} of ${feed.items} ${feed.format} feed items carry no stable identifier, so readers show them again as new`, value: feed.unidentified, locations: feed.unidentified.map((position) => `item ${position}`) }];
}, { docs: DOCS.rss, fix: "Give every item a `guid` (RSS), `id` (Atom or JSON Feed) that never changes once published." });

const websub = pageRule("feeds/websub", [`${ID}.hubs`, `${ID}.self`], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    return feed.hubs.length === 0 || feed.self ? [] : [{ message: `${feed.format} feed names WebSub hub ${feed.hubs.join(", ")} but no self URL to subscribe to`, value: feed.hubs }];
}, { docs: DOCS.websub, fix: "Declare `rel=\"self\"` beside `rel=\"hub\"`, in the feed or its `Link` header." });

// The first value of a header that may repeat.
const firstHeader = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

// An enclosure HEAD answer judged against its declaration: reachability, byte and type agreement, range support.
const enclosure = pageRule("feeds/enclosure", [`${ID}.enclosures`, "resources"], (page) => {
    const feed = parsed(page);
    if (!feed?.enclosures || !feed.podcast) return;
    const answers = new Map((page.resources ?? []).filter((resource) => resource.kind === "enclosure").map((resource) => [resource.url, resource.http]));
    const locations = feed.enclosures.flatMap(({ url, length: declaredLength, type: declaredType, position }) => {
        const answer = answers.get(url);
        if (!answer) return [];
        if (answer.status < 200 || answer.status > 299) return [`item ${position} ${url} answers ${answer.status}`];
        const faults = [];
        const length = firstHeader(answer.headers["content-length"]);
        if (length !== undefined && declaredLength !== undefined && length !== declaredLength) faults.push(`serves ${length} bytes, the feed declares ${declaredLength}`);
        const type = firstHeader(answer.headers["content-type"])?.split(";", 1)[0]?.trim().toLowerCase();
        if (type !== undefined && declaredType !== undefined && type !== declaredType.toLowerCase()) faults.push(`serves ${type}, the feed declares ${declaredType}`);
        const ranges = [answer.headers["accept-ranges"] ?? []].flat().join(",").toLowerCase();
        if (!ranges.split(",").map((token) => token.trim()).includes("bytes")) faults.push("sends no Accept-Ranges: bytes");
        return faults.map((fault) => `item ${position} ${url} ${fault}`);
    });
    log.debug({ rule: "feeds/enclosure", url: page.url.href, enclosures: feed.enclosures.length, locations: locations.length }, "enclosures judged");
    return locations.length === 0 ? [] : [{ message: `${feed.format} feed enclosures disagree with their host: ${locations[0]}${locations.length > 1 ? ` and ${locations.length - 1} more` : ""}`, value: locations.length, locations }];
}, { docs: DOCS.itunes, fix: "Serve every enclosure with its declared Content-Type and Content-Length over a host answering HEAD and byte ranges." });

// A podcast feed without `<podcast:locked>`, which leaves the feed importable anywhere.
const podcastLocked = pageRule("feeds/podcast-locked", [`${ID}.locked`], (page) => {
    const feed = parsed(page);
    if (!feed?.podcast) return;
    if (feed.locked === undefined) return [{ message: `${feed.format} podcast feed sets no podcast:locked, so any platform may import it` }];
    return feed.locked === "yes" || feed.locked === "no" ? [] : [{ message: `${feed.format} podcast feed locks with “${feed.locked}”, which is neither yes nor no`, value: feed.locked }];
}, { docs: DOCS.locked, fix: "Add `<podcast:locked>yes</podcast:locked>` to keep the feed where it is, or `no` to let platforms import it." });

// A rule reporting one problem list the extractor filled, one finding per feed with each problem as a location; `podcast` rules skip other feeds.
function problemRule(name: string, label: string, reference: string, fix: string, isPodcast = false): [string, Make] {
    const id = `feeds/${name}`;
    return [id, pageRule(id, [`${ID}.problems.${name}`], (page) => {
        const feed = parsed(page);
        if (!feed?.problems || (isPodcast && !feed.podcast)) return;
        const list = feed.problems[name] ?? [];
        return list.length === 0 ? [] : [{ message: `${feed.format} feed ${label}: ${list[0]}${list.length > 1 ? ` and ${list.length - 1} more` : ""}`, value: list, locations: list }];
    }, { docs: reference, fix })];
}

const PROBLEM_RULES = Object.fromEntries([
    problemRule("required", "lacks what its format requires", DOCS.rss2, "Add the element the location names: RSS needs a channel title, link and description and a title or description per item; Atom an id, title and updated on the feed and every entry, and an author; JSON Feed a title and an id per item."),
    problemRule("date-format", "carries a date readers cannot parse", DOCS.rss, "Write RSS dates as RFC 822 with a four-digit year and a zone, `Wed, 02 Oct 2026 14:00:00 +0000`, and Atom and JSON Feed dates as RFC 3339, `2026-10-02T14:00:00Z`."),
    problemRule("duplicate-id", "repeats an item identifier", DOCS.rss, "Give every item its own `guid` or `id`, so readers neither merge two posts nor drop one."),
    problemRule("id-tracking", "puts a tracking parameter into an item identifier", DOCS.rss, "Keep `utm_*` and other campaign parameters out of `guid` and `id`; put them on the item link only, so the identifier never changes."),
    problemRule("permalink", "names a guid that is not a URL while claiming it is a permalink", DOCS.rss2, "Add `isPermaLink=\"false\"` to a `guid` that is not the item’s URL."),
    problemRule("absolute-url", "carries a relative URL", DOCS.rss, "Write every channel, item and enclosure URL absolute, `https://example.org/posts/1`."),
    problemRule("language", "declares a language that is not a BCP 47 tag", "https://www.rfc-editor.org/info/bcp47", "Declare the language as a BCP 47 tag, `en` or `pt-BR`."),
    problemRule("unknown-element", "carries elements RSS 2.0 does not define", DOCS.rss2, "Move an extension element into its own namespace, `<dc:creator>`, or remove it."),
    problemRule("email", "names an email field that is not `address (Name)`", DOCS.rss2, "Write `managingEditor`, `webMaster` and `author` as `editor@example.org (Ana Silva)`."),
    problemRule("json-version", "uses an outdated JSON Feed form", DOCS.json, "Declare `\"version\": \"https://jsonfeed.org/version/1.1\"` and list `authors` instead of `author`."),
    problemRule("raw-markup", "delivers unrendered Markdown or MDX to readers", DOCS.rss, "Render each item’s Markdown or MDX to HTML before it goes into the feed, as the page itself does."),
    problemRule("template-leak", "delivers template placeholders or missing values to readers", DOCS.rss, "Fill every template value before the feed is written, and leave out a field that has no value."),
    problemRule("relative-url", "links images or pages by a relative URL, which breaks in every reader", DOCS.rss, "Make every `href` and `src` inside item content absolute, or set `xml:base` on the Atom content."),
    problemRule("unsafe-html", "carries markup readers strip", DOCS.rss, "Leave scripts, frames, forms, event handlers and positioned styles out of item content; readers remove them."),
    problemRule("double-escaped", "escapes item content twice, so readers show tags and entities as text", DOCS.rss, "Escape item HTML once: either wrap it in CDATA or escape it, not both."),
    problemRule("content-type", "holds HTML in a plain-text field", DOCS.atom, "Declare Atom `type=\"html\"` on content holding tags, or put HTML into JSON Feed `content_html`."),
    problemRule("title-markup", "carries markup or placeholders in an item title", DOCS.rss, "Write item titles as plain text, with no tags, entities or template values."),
    problemRule("media-type", "is served with a type readers do not treat as a feed", DOCS.rss, "Serve RSS as `application/rss+xml`, Atom as `application/atom+xml` and JSON Feed as `application/feed+json`."),
    problemRule("charset", "declares or decodes its encoding inconsistently", "https://www.w3.org/TR/xml/#charencoding", "Serve the feed as UTF-8 and declare the same encoding in `Content-Type` and the XML declaration."),
    problemRule("itunes-required", "lacks what podcast directories require", DOCS.itunes, "Add `itunes:image`, `itunes:category`, `itunes:explicit`, `itunes:author` and `language` to the channel, and write each `itunes:duration` as seconds or `HH:MM:SS`.", true),
    problemRule("podcast-guid", "has no stable Podcasting 2.0 GUID", DOCS.podcast, "Add `<podcast:guid>` with the UUIDv5 of the feed URL the location names, and keep it when the feed moves.", true),
]);

// An item dated after the response that served it.
const dateFuture = pageRule("feeds/date-future", [`${ID}.entries`], (page) => {
    const feed = parsed(page);
    if (!feed?.entries) return;
    const now = Date.parse(header(page, "date")) || Date.now();
    const future = feed.entries.filter((entry) => entry.published && Date.parse(entry.published) > now + DAY_MS / 24);
    log.debug({ rule: "feeds/date-future", url: page.url.href, now: new Date(now).toISOString(), future: future.length }, "feed dates compared");
    return future.length === 0 ? [] : [{ message: `${future.length} of ${feed.items} ${feed.format} feed items are dated after the response, so readers sort them above everything else`, locations: future.map((entry) => `item ${entry.position}: ${entry.published}`) }];
}, { docs: DOCS.rss, fix: "Date each item when it was published; hold a scheduled post out of the feed until then." });

// A feed whose newest item, or whose build date, is old.
const stale: Make = (severity, settings) => pageRule("feeds/stale", [`${ID}.entries`, `${ID}.updated`], (page) => {
    const feed = parsed(page);
    if (!feed?.entries || feed.entries.length === 0) return;
    const days = (settings as FeedsSettings | undefined)?.["stale-days"] ?? 365;
    const now = Date.parse(header(page, "date")) || Date.now();
    const newest = Math.max(...feed.entries.map((entry) => (entry.published ? Date.parse(entry.published) : 0)));
    const locations = [...(newest > 0 && now - newest > days * DAY_MS ? [`newest item ${new Date(newest).toISOString()} is over ${days} days old`] : []), ...(feed.updated && newest > 0 && Date.parse(feed.updated) + DAY_MS < newest ? [`build date ${feed.updated} is before the newest item`] : [])];
    log.debug({ rule: "feeds/stale", url: page.url.href, newest, days, locations: locations.length }, "feed age judged");
    return locations.length === 0 ? [] : [{ message: `${feed.format} feed looks stale: ${locations[0]}`, locations }];
}, { docs: DOCS.rss, fix: "Publish the feed with every new post, and set `lastBuildDate` or `updated` when it is rebuilt." })(severity);

// A feed readers must download in full on every poll.
const conditionalGet = pageRule("feeds/conditional-get", [`${ID}.format`, "http.headers.etag", "http.headers.last-modified", "http.unmodified"], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    if (page.http.unmodified) return [{ message: `${feed.format} feed answers a conditional request with 200 and an unchanged body instead of 304, so every reader downloads it in full on every poll` }];
    const isValidated = header(page, "etag") !== "" || header(page, "last-modified") !== "";
    return isValidated ? [] : [{ message: `${feed.format} feed sends neither ETag nor Last-Modified, so every reader downloads it in full on every poll` }];
}, { docs: "https://www.rfc-editor.org/rfc/rfc9110#section-13.1", fix: "Send `ETag` or `Last-Modified` with the feed and answer conditional requests with 304." });

// Caching that makes every poll a full fetch, or contradicts the feed’s own refresh hint.
const cache = pageRule("feeds/cache", [`${ID}.ttl`, "http.headers.cache-control"], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    const control = header(page, "cache-control").toLowerCase();
    const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/.exec(control)?.[1];
    const locations = [...(/(?:^|,)\s*no-store\b/.test(control) ? ["Cache-Control: no-store"] : []), ...(maxAge && feed.ttl && (Number(maxAge) > feed.ttl * 600 || Number(maxAge) * 10 < feed.ttl * 60) ? [`ttl ${feed.ttl} min against max-age ${maxAge} s`] : [])];
    return locations.length === 0 ? [] : [{ message: `${feed.format} feed caching works against its readers: ${locations[0]}`, locations }];
}, { docs: "https://www.rfc-editor.org/rfc/rfc9111#section-5.2", fix: "Let readers cache the feed for as long as `ttl` says, `Cache-Control: max-age=3600` for a one-hour `ttl`, and never `no-store`." });

// A feed body too large, or large and uncompressed.
const size: Make = (severity, settings) => pageRule("feeds/size", [`${ID}.format`, "http.size", "http.headers.content-encoding"], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    const limit = (settings as FeedsSettings | undefined)?.["max-bytes"] ?? 1_048_576;
    const decoded = page.http.size.decoded;
    const locations = [...(decoded > limit ? [`${decoded} bytes, over ${limit}`] : []), ...(decoded > 10_240 && !header(page, "content-encoding") ? [`${decoded} bytes served uncompressed`] : [])];
    return locations.length === 0 ? [] : [{ message: `${feed.format} feed costs every poll ${decoded} bytes: ${locations[0]}`, value: decoded, locations }];
}, { docs: DOCS.rss, fix: "Keep the newest items only, and serve the feed compressed with `br` or `gzip`." })(severity);

// A feed styled through XSLT, which Chrome stops applying.
const xslt = pageRule("feeds/xslt", [`${ID}.stylesheet`], (page) => {
    const feed = parsed(page);
    if (!feed) return;
    return feed.stylesheet ? [{ message: `${feed.format} feed is styled by ${feed.stylesheet}; Chrome 158 (2026-11-17) stops applying XSLT, so visitors there see raw XML`, value: feed.stylesheet }] : [];
}, { docs: DOCS.xslt, fix: "Link a human-readable page from the feed instead of relying on an XSL stylesheet." });

// Crawled pages by URL and by the URL that was requested.
function indexOf(pages: Facts[]): Map<string, Facts> {
    const index = new Map<string, Facts>();
    for (const page of pages) {
        index.set(page.url.href, page);
        if (page.crawl.requested) index.set(resolve(page.crawl.requested, page.url.href), page);
    }
    return index;
}

type Judge = (feed: FeedFacts, page: Facts, index: Map<string, Facts>, site?: SiteFacts) => string[];

// A site rule: one finding per parsed feed, each location a problem `judge` finds against the crawl.
function siteRule(id: string, facts: string[], label: string, judge: Judge, guide: { docs: string; fix: string }): Make {
    return (severity) => ({
        meta: { id, severity, scope: "site", facts, ...guide },
        check(pages: Facts[], _group?: string, site?: SiteFacts) {
            const index = indexOf(pages);
            const findings: Finding[] = [];
            for (const page of pages) {
                const feed = parsed(page);
                if (!feed?.entries) continue;
                const locations = judge(feed, page, index, site);
                log.debug({ rule: id, url: page.url.href, locations: locations.length }, "feed joined to the crawl");
                if (locations.length > 0) findings.push({ rule: id, severity, scope: "site", url: page.url.href, message: `${feed.format} feed ${label}: ${locations[0]}${locations.length > 1 ? ` and ${locations.length - 1} more` : ""}`, value: locations.length, locations });
            }
            return findings;
        },
    });
}

const isOk = (page: Facts) => page.http.status >= 200 && page.http.status <= 299;
const normal = (text: string) => text.toLowerCase().replaceAll(/\s+/g, " ").trim();

// The crawled page an item links, its landing URL when the crawl followed a redirect.
function target(entry: FeedEntry, index: Map<string, Facts>, site?: SiteFacts): { page?: Facts; landing?: string } {
    if (!entry.link) return {};
    const landing = site?.redirects?.[entry.link];
    return { page: index.get(entry.link) ?? (landing ? index.get(landing) : undefined), ...(landing && { landing }) };
}

const itemStatus = siteRule("feeds/item-status", [`${ID}.entries`, "http.status", "site.redirects"], "links items to pages that fail or redirect", (feed, _page, index, site) => (feed.entries ?? []).flatMap((entry) => {
    const { page, landing } = target(entry, index, site);
    if (landing) return [`item ${entry.position} ${entry.link} redirects to ${landing}`];
    return page && !isOk(page) ? [`item ${entry.position} ${entry.link} answers ${page.http.status}`] : [];
}), { docs: DOCS.rss, fix: "Point each item link at the final URL of a page that answers 200." });

const itemCanonical = siteRule("feeds/item-canonical", [`${ID}.entries`, "html.canonical"], "links items away from their canonical URL", (feed, _page, index, site) => (feed.entries ?? []).flatMap((entry) => {
    const { page, landing } = target(entry, index, site);
    if (landing || !page?.html?.canonical || !entry.link || !isOk(page)) return [];
    const canonical = resolve(page.html.canonical, page.url.href);
    const here = [page.url.href, page.url.twin, entry.link].flatMap((href) => (href ? [resolve(href, href)] : []));
    return here.includes(canonical) ? [] : [`item ${entry.position} links ${entry.link}, its canonical is ${canonical}`];
}), { docs: DOCS.rss, fix: "Link each item to its page’s canonical URL." });

const itemTitle = siteRule("feeds/item-title", [`${ID}.entries`, "html.title", "html.property"], "titles items unlike the pages they link", (feed, _page, index, site) => (feed.entries ?? []).flatMap((entry) => {
    const { page, landing } = target(entry, index, site);
    if (landing || !page?.html || !entry.title || !isOk(page)) return [];
    const titles = [page.html.title, page.html.property["og:title"]].flatMap((title) => (title ? [normal(title)] : []));
    return titles.length === 0 || titles.some((title) => title.includes(normal(entry.title as string))) ? [] : [`item ${entry.position} “${entry.title}” against “${page.html.title ?? page.html.property["og:title"]}”`];
}), { docs: DOCS.rss, fix: "Use the page’s own title as the item title." });

const itemDate = siteRule("feeds/item-date", [`${ID}.entries`, "html.published"], "dates items unlike the pages they link", (feed, _page, index, site) => (feed.entries ?? []).flatMap((entry) => {
    const { page, landing } = target(entry, index, site);
    const published = landing ? undefined : page?.html?.published;
    if (!published || !entry.published || Number.isNaN(Date.parse(published))) return [];
    return Math.abs(Date.parse(published) - Date.parse(entry.published)) > DAY_MS ? [`item ${entry.position} ${entry.published}, the page says ${published}`] : [];
}), { docs: DOCS.rss, fix: "Take the item date from the same field the page’s `article:published_time` or `datePublished` comes from." });

// A feed carrying summaries where readers expect full posts: every linked page far longer than its item.
const summaryOnly = siteRule("feeds/summary-only", [`${ID}.entries`, "html.text"], "carries summaries while the linked pages say far more", (feed, _page, index, site) => {
    const judged = (feed.entries ?? []).flatMap((entry) => {
        const { page, landing } = target(entry, index, site);
        const pageWords = page?.html?.text;
        return landing || !page || !pageWords || entry.words === undefined || !isOk(page) || pageWords < 150 ? [] : [{ entry, words: entry.words, pageWords }];
    });
    const short = judged.filter(({ words, pageWords }) => words < pageWords * 0.3);
    return short.length === judged.length && judged.length > 0 ? short.map(({ entry, words, pageWords }) => `item ${entry.position}: ${words} words against ${pageWords} on the page`) : [];
}, { docs: DOCS.rss, fix: "Put the full post text into each item’s `content:encoded`, `content` or `content_html`, not a summary." });

// Pages advertising a feed through a head link, by the feed’s URL.
function advertisers(pages: Facts[]): Map<string, { page: Facts; type: string }[]> {
    const byFeed = new Map<string, { page: Facts; type: string }[]>();
    for (const page of pages) {
        const links = page.html?.head.links ?? [];
        for (const link of links) {
            const type = link.type?.toLowerCase() ?? "";
            if (!/\balternate\b/i.test(link.rel ?? "") || !FEED_TYPES.has(type) || !link.href) continue;
            const href = resolve(link.href, page.url.href);
            byFeed.set(href, [...(byFeed.get(href) ?? []), { page, type }]);
        }
    }
    return byFeed;
}

const primary = (tag: string) => tag.toLowerCase().split(/[-_]/, 1)[0];

const pageLanguage = siteRule("feeds/page-language", [`${ID}.language`, "html.lang", "html.head.links"], "declares a language other than the pages advertising it", (feed, page, index) => {
    if (!feed.language) return [];
    const byFeed = advertisers([...new Set(index.values())]);
    const pages = [...(byFeed.get(page.url.href) ?? []), ...(page.crawl.requested ? (byFeed.get(resolve(page.crawl.requested, page.url.href)) ?? []) : [])];
    return pages.filter(({ page: advertiser }) => advertiser.html?.lang && primary(advertiser.html.lang) !== primary(feed.language as string)).map(({ page: advertiser }) => `${advertiser.url.href} is ${advertiser.html?.lang}, the feed ${feed.language}`);
}, { docs: DOCS.discovery, fix: "Link each locale’s own feed from its pages, and declare that locale as the feed’s language." });

const stylesheet = siteRule("feeds/stylesheet", [`${ID}.stylesheet`, "http.status", "http.content-type"], "names a stylesheet browsers will not apply", (feed, page, index) => {
    if (!feed.stylesheet) return [];
    if (new URL(feed.stylesheet).origin !== page.url.origin) return [`${feed.stylesheet} is on another origin, which browsers refuse for XSLT`];
    const sheet = index.get(feed.stylesheet);
    if (!sheet) return [];
    if (!isOk(sheet)) return [`${feed.stylesheet} answers ${sheet.http.status}`];
    return XSL_TYPES.has(sheet.http["content-type"]) ? [] : [`${feed.stylesheet} is served as ${sheet.http["content-type"] || "no type"}`];
}, { docs: "https://www.w3.org/TR/xml-stylesheet/", fix: "Serve the XSL stylesheet from the feed’s own origin as `text/xsl`." });

const archive = siteRule("feeds/archive", [`${ID}.archives`, `${ID}.problems.archive`, "http.status"], "names archive pages readers cannot follow", (feed, _page, index) => [
    ...(feed.problems?.archive ?? []),
    ...Object.entries(feed.archives ?? {}).flatMap(([relation, href]) => {
        const linked = index.get(href);
        if (!linked) return [];
        if (!isOk(linked)) return [`${relation} ${href} answers ${linked.http.status}`];
        return parsed(linked) ? [] : [`${relation} ${href} is not a feed`];
    }),
], { docs: DOCS.archive, fix: "Point `prev-archive`, `next-archive` and `current` at feed documents that answer 200, and drop them from a complete feed." });

const ARTWORK_MIN = 1400;
const ARTWORK_MAX = 3000;
const ARTWORK_TYPES = new Map([["jpeg", "JPEG"], ["png", "PNG"]]);

// What a `itunes:image` URL answered: its served type, format and pixel sizes.
export interface FeedImageFile {
    status: number;
    type?: string;
    format?: string;
    width?: number;
    height?: number;
    error?: string;
}

export interface FeedImagesFacts {
    declared: string[];
    files: Record<string, FeedImageFile>;
    "itunes-image": string[];
}

// The pixel sizes of an image body; an unrecognised body has no format.
async function measureImage(url: string, bytes: Buffer): Promise<Pick<FeedImageFile, "format" | "width" | "height">> {
    try {
        const metadata = await sharp(bytes, { limitInputPixels: 50_000_000 }).metadata();
        return { format: metadata.format, width: metadata.width, height: metadata.height };
    } catch (error) {
        log.debug({ url, error: reason(error) }, "podcast artwork is no image");
        return {};
    }
}

// Every channel artwork the origin’s podcast feeds name, fetched once, measured and judged.
const feedImages: SiteExtractor = {
    id: "feed-images",
    per: "origin",
    crawled: true,
    async extract(origin, context) {
        const declared = [...new Set(context.pages.flatMap((page) => {
            const feed = page.feed as FeedFacts | undefined;
            return feed?.podcast && feed.itunesImage ? [feed.itunesImage] : [];
        }))];
        if (declared.length === 0) return;
        const fetchOne = async (url: string): Promise<FeedImageFile> => {
            try {
                const answer = await (new URL(url).origin === origin ? context.fetch : context.delegated)(url, { redirect: "follow", binary: true });
                const isOk = answer.status >= 200 && answer.status <= 299;
                const measured = isOk && answer.bytes ? await measureImage(url, answer.bytes) : {};
                log.debug({ url, status: answer.status, ...measured }, "podcast artwork fetched");
                const type = answer.headers["content-type"];
                return { status: answer.status, ...(typeof type === "string" && { type }), ...measured };
            } catch (error) {
                log.debug({ url, error: reason(error) }, "podcast artwork unreachable");
                return { status: 0, error: error instanceof RobotsDisallowed ? "robots.txt disallows it" : reason(error) };
            }
        };
        const files = Object.fromEntries(await Promise.all(declared.map(async (url) => [url, await fetchOne(url)] as const)));
        const problems = declared.flatMap((url) => {
            const file = files[url] as FeedImageFile;
            if (file.error) return [`${url} does not answer (${file.error})`];
            if (file.status < 200 || file.status > 299) return [`${url} answers ${file.status}`];
            if (!file.format) return [`${url} is not an image (${file.type || "no type"})`];
            if (!ARTWORK_TYPES.has(file.format)) return [`${url} is ${file.format}, not JPEG or PNG`];
            if (file.width !== file.height) return [`${url} is ${file.width}x${file.height}, not square`];
            const width = file.width ?? 0;
            return width < ARTWORK_MIN || width > ARTWORK_MAX ? [`${url} is ${file.width} px wide, Apple wants ${ARTWORK_MIN}–${ARTWORK_MAX}`] : [];
        });
        log.debug({ origin, declared: declared.length, problems: problems.length }, "podcast artwork measured");
        return { declared, files, "itunes-image": problems } satisfies FeedImagesFacts;
    },
};

export interface FeedHubsFacts {
    hubs: string[];
    problems: string[];
}

// Every WebSub hub the origin’s feeds declare, asked once whether it answers a discovery request.
const feedHubs: SiteExtractor = {
    id: "feed-hubs",
    per: "origin",
    crawled: true,
    async extract(origin, context) {
        const hubs = [...new Set(context.pages.flatMap((page) => {
            const feed = page.feed as FeedFacts | undefined;
            return feed && !feed.error ? feed.hubs : [];
        }))];
        if (hubs.length === 0) return;
        if (!(context.settings as FeedsSettings | undefined)?.websub) {
            log.info({ origin, hubs: hubs.length }, "feeds/websub-hub skipped: opt in with org.spiderlint.feeds.websub");
            return;
        }
        const problems: string[] = [];
        for (const hub of hubs) {
            try {
                const answer = await (new URL(hub).origin === origin ? context.fetch : context.delegated)(hub, { redirect: "follow" });
                log.debug({ hub, status: answer.status }, "websub hub probed");
                if (answer.status < 200 || answer.status > 299) problems.push(`${hub} answers ${answer.status}`);
            } catch (error) {
                log.debug({ hub, error: reason(error) }, "websub hub unreachable");
                if (!(error instanceof RobotsDisallowed)) problems.push(`${hub} does not answer (${reason(error)})`);
            }
        }
        log.debug({ origin, hubs: hubs.length, problems: problems.length }, "websub hubs probed");
        return { hubs, problems } satisfies FeedHubsFacts;
    },
};

// Head links announcing a feed type the target is not, or a target that is no feed at all; one finding per target.
const discoveryType: Make = (severity) => ({    meta: { id: "feeds/discovery-type", severity, scope: "site", facts: ["html.head.links", ID], docs: DOCS.discovery, fix: "Give each `rel=alternate` the type the feed is served as, and point it at the feed itself." },
    check(pages: Facts[]) {
        const index = indexOf(pages);
        const findings: Finding[] = [];
        for (const [href, links] of advertisers(pages)) {
            const linked = index.get(href);
            if (!linked || !isOk(linked)) continue;
            const feed = feedOf(linked);
            const wrong = links.filter(({ type }) => !feed || FORMAT_TYPES[type] !== feed.format);
            log.debug({ rule: "feeds/discovery-type", url: href, format: feed?.format, links: links.length, wrong: wrong.length }, "feed discovery judged");
            if (wrong.length === 0) continue;
            const urls = [...new Set(wrong.map(({ page }) => page.url.href))];
            const message = feed ? `head links announce ${href} as ${wrong[0]?.type}, it is ${feed.format}` : `head links announce ${href} as a feed, it is ${linked.http["content-type"] || "no type"}`;
            findings.push({ rule: "feeds/discovery-type", severity, scope: "site", url: href, message: `${message}; linked from ${urls.length} page${urls.length === 1 ? "" : "s"}`, urls });
        }
        return findings;
    },
});

// A group where some HTML pages advertise a feed and others do not.
const discovery: Make = (severity) => ({
    meta: { id: "feeds/discovery", severity, scope: "group", facts: ["html.head.links"], docs: DOCS.discovery, fix: "Link the feed with `<link rel=alternate type=application/atom+xml>` from every page of the template, not from some." },
    check(pages: Facts[], group?: string): Finding[] | undefined {
        const html = pages.filter((page) => page.html !== undefined && isOk(page) && !feedOf(page));
        const without = html.filter((page) => (page.html?.head.links ?? []).every((link) => !(/\balternate\b/i.test(link.rel ?? "") && FEED_TYPES.has(link.type?.toLowerCase() ?? "")))).map((page) => page.url.href);
        log.debug({ rule: "feeds/discovery", group, pages: html.length, without: without.length }, "feed links judged");
        if (without.length === html.length) return;
        return without.length === 0 ? [] : [{ rule: "feeds/discovery", severity, scope: "group", url: without[0] as string, ...(group !== undefined && { group }), message: `${without.length} of ${html.length} pages advertise no feed while the rest do`, urls: without }];
    },
});

const RULES: Record<string, Make> = {
    "feeds/well-formed": wellFormed,
    "feeds/self": self,
    "feeds/item-id": itemId,
    "feeds/websub": websub,
    ...PROBLEM_RULES,
    "feeds/date-future": dateFuture,
    "feeds/stale": stale,
    "feeds/conditional-get": conditionalGet,
    "feeds/cache": cache,
    "feeds/size": size,
    "feeds/xslt": xslt,
    "feeds/item-status": itemStatus,
    "feeds/item-canonical": itemCanonical,
    "feeds/item-title": itemTitle,
    "feeds/item-date": itemDate,
    "feeds/summary-only": summaryOnly,
    "feeds/page-language": pageLanguage,
    "feeds/stylesheet": stylesheet,
    "feeds/archive": archive,
    "feeds/discovery-type": discoveryType,
    "feeds/discovery": discovery,
    "feeds/enclosure": enclosure,
    "feeds/podcast-locked": podcastLocked,
};

export default definePlugin({
    name: "feeds",
    settings: {
        type: "object",
        additionalProperties: false,
        properties: { "stale-days": { type: "integer", minimum: 1, default: 365 }, "max-bytes": { type: "integer", minimum: 1, default: 1_048_576 }, websub: { type: "boolean", default: false } },
    },
    extractors: [{ id: ID, inputs: ["headers.link"], extract }],
    rules: RULES,
    sites: [feedImages, feedHubs],
    presets: {
        feeds: {
            description: "RSS, Atom and JSON Feed as readers need them: valid to their specification, content rendered, served for polling, and in step with the pages they describe",
            rules: {
                "feeds/well-formed": "error",
                "feeds/required": "error",
                "feeds/date-format": "error",
                "feeds/duplicate-id": "error",
                "feeds/raw-markup": "error",
                "feeds/template-leak": "error",
                "feeds/self": "warning",
                "feeds/item-id": "warning",
                "feeds/websub": "warning",
                "feeds/id-tracking": "warning",
                "feeds/permalink": "warning",
                "feeds/absolute-url": "warning",
                "feeds/language": "warning",
                "feeds/unknown-element": "warning",
                "feeds/email": "warning",
                "feeds/json-version": "warning",
                "feeds/relative-url": "warning",
                "feeds/unsafe-html": "warning",
                "feeds/double-escaped": "warning",
                "feeds/content-type": "warning",
                "feeds/title-markup": "warning",
                "feeds/media-type": "warning",
                "feeds/charset": "warning",
                "feeds/date-future": "warning",
                "feeds/conditional-get": "warning",
                "feeds/cache": "warning",
                "feeds/size": "warning",
                "feeds/stylesheet": "warning",
                "feeds/archive": "warning",
                "feeds/item-status": "warning",
                "feeds/item-canonical": "warning",
                "feeds/item-date": "warning",
                "feeds/page-language": "warning",
                "feeds/discovery-type": "warning",
                "feeds/discovery": "warning",
                "feeds/item-title": "info",
                "feeds/summary-only": "info",
                "feeds/stale": "info",
                "feeds/xslt": "info",
            },
        },
        podcasts: {
            description: "Podcast feeds as directories require them: iTunes channel and episode tags, a stable Podcasting 2.0 GUID, reachable enclosures and directory-ready artwork",
            rules: {
                "feeds/itunes-required": "warning",
                "feeds/podcast-guid": "warning",
                "feeds/enclosure": "warning",
                "feeds/itunes-image": { fact: "site.origins.*.feed-images.itunes-image", expect: { maxItems: 0 }, message: "podcast artwork is missing or unfit: {got}", severity: "warning", docs: DOCS.itunes, fix: "Serve the channel itunes:image as a square JPEG or PNG between 1400 and 3000 px on each side." },
                "feeds/podcast-locked": "info",
            },
        },
        websub: {
            description: "WebSub as subscribers need it: every feed naming its self URL beside its hub, each hub probed once; probing opts in with org.spiderlint.feeds.websub",
            rules: {
                "feeds/websub": "warning",
                "feeds/websub-hub": { fact: "site.origins.*.feed-hubs.problems", expect: { maxItems: 0 }, message: "declared WebSub hub does not answer: {got}", severity: "warning", docs: DOCS.websub, fix: "Point each rel=hub link at a hub that answers 200, or remove it." },
            },
        },
    },
});
