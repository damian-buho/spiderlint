// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { SaxesParser, type SaxesTagNS } from "saxes";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { header, linkTargets, pageRule, resolve } from "../rules/builtin.ts";
import { definePlugin } from "./types.ts";

const ID = "feed";
const ATOM = "http://www.w3.org/2005/Atom";
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/feed+json"]);
const XML_ROOT = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:rss|feed|rdf:RDF)[\s>]/;
const JSON_FEED = /^https:\/\/jsonfeed\.org\/version\//;

export interface FeedFacts {
    format: "rss" | "atom" | "json";
    error?: string;
    self?: string;
    hubs: string[];
    items: number;
    // 1-based positions of the items carrying no `guid`, `id` or `rdf:about`.
    unidentified: number[];
}

type Body = Omit<FeedFacts, "format" | "error">;

// An RSS item or an Atom entry.
const isItem = (tag: SaxesTagNS) => tag.local === "item" || (tag.local === "entry" && tag.uri === ATOM);

// Links, items and identifiers of an RSS or Atom document; throws on the first well-formedness error.
function readXml(body: string, base: string): Body {
    const parser = new SaxesParser({ xmlns: true });
    const stack: SaxesTagNS[] = [];
    const read: Body = { hubs: [], items: 0, unidentified: [] };
    let text = "";
    let isIdentified: boolean | undefined;
    parser.on("opentag", (tag) => {
        const parent = stack.at(-1)?.local;
        stack.push(tag);
        text = "";
        if (isItem(tag)) {
            read.items += 1;
            isIdentified = tag.attributes["rdf:about"] !== undefined;
        }
        if (tag.local !== "link" || tag.uri !== ATOM || (parent !== "channel" && parent !== "feed")) return;
        const [relation, href] = [tag.attributes.rel?.value ?? "alternate", tag.attributes.href?.value ?? ""];
        if (relation === "self") read.self ??= resolve(href, base);
        else if (relation === "hub") read.hubs.push(resolve(href, base));
    });
    parser.on("text", (chunk) => (text += chunk));
    parser.on("cdata", (chunk) => (text += chunk));
    parser.on("closetag", (tag) => {
        stack.pop();
        if ((tag.local === "guid" || (tag.local === "id" && tag.uri === ATOM)) && text.trim()) isIdentified = true;
        if (isIdentified === undefined || !isItem(tag)) return;
        if (!isIdentified) read.unidentified.push(read.items);
        isIdentified = undefined;
    });
    parser.write(body).close();
    return read;
}

// The same of a JSON Feed; undefined when the document is JSON but no JSON Feed.
function readJson(body: string, base: string): Body | undefined {
    const feed = JSON.parse(body) as { version?: unknown; feed_url?: unknown; hubs?: { url?: unknown }[]; items?: { id?: unknown }[] };
    if (typeof feed.version !== "string" || !JSON_FEED.test(feed.version)) return undefined;
    const items = Array.isArray(feed.items) ? feed.items : [];
    const hubs = (Array.isArray(feed.hubs) ? feed.hubs : []).flatMap((hub) => (typeof hub.url === "string" ? [resolve(hub.url, base)] : []));
    const unidentified = items.flatMap((item, index) => (typeof item.id === "string" && item.id.trim() ? [] : [index + 1]));
    return { ...(typeof feed.feed_url === "string" && { self: resolve(feed.feed_url, base) }), hubs, items: items.length, unidentified };
}

// The feed format a page’s type or root element announces.
function formatOf(page: Facts, body: string): FeedFacts["format"] | undefined {
    const type = page.http["content-type"];
    if (type === "application/feed+json" || (type === "application/json" && body.includes("jsonfeed.org/version/"))) return "json";
    if (!FEED_TYPES.has(type) && !(/[/+]xml$/.test(type) && XML_ROOT.test(body))) return undefined;
    return type === "application/atom+xml" || /<feed[\s>]/.test(body.slice(0, 2048)) ? "atom" : "rss";
}

// Feed facts of an RSS, Atom or JSON Feed page, the `Link` header adding a self or hub the body lacks.
async function extract(page: Facts, body: string): Promise<FeedFacts | undefined> {
    const format = formatOf(page, body);
    if (!format || page.http.size.truncated) {
        log.debug({ url: page.url.href, contentType: page.http["content-type"], format, truncated: page.http.size.truncated === true }, "feed skipped");
        return;
    }
    let read: Body | undefined;
    try {
        read = format === "json" ? readJson(body, page.url.href) : readXml(body, page.url.href);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug({ url: page.url.href, format, error: message }, "feed unparsable");
        return { format, error: message, hubs: [], items: 0, unidentified: [] };
    }
    if (!read) return;
    const link = header(page, "link");
    const self = read.self ?? linkTargets(link, "self", page.url.href)[0];
    const hubs = read.hubs.length > 0 ? read.hubs : linkTargets(link, "hub", page.url.href);
    log.debug({ url: page.url.href, format, self, hubs: hubs.length, items: read.items, unidentified: read.unidentified.length }, "feed read");
    return { ...read, format, ...(self && { self }), hubs };
}

const feedOf = (page: Facts) => page[ID] as FeedFacts | undefined;
// A feed that parsed, else undefined so its rule skips.
const parsed = (page: Facts) => (feedOf(page)?.error === undefined ? feedOf(page) : undefined);
const DOCS = { rss: "https://www.rssboard.org/rss-profile", websub: "https://www.w3.org/TR/websub/#discovery" };

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

export default definePlugin({
    name: "feeds",
    extractors: [{ id: ID, inputs: ["headers.link"], extract }],
    rules: { "feeds/well-formed": wellFormed, "feeds/self": self, "feeds/item-id": itemId, "feeds/websub": websub },
    presets: {
        feeds: {
            description: "RSS, Atom and JSON Feed hygiene: well-formed, a self URL, a stable identifier per item, WebSub discovery",
            rules: { "feeds/well-formed": "error", "feeds/self": "warning", "feeds/item-id": "warning", "feeds/websub": "warning" },
        },
    },
});
