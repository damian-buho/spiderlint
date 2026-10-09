// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";
import { isJudged } from "../crawl/links.ts";
import { mediaOf } from "../crawl/sitemap.ts";
import type { Facts, HtmlFacts, ParsedHeader, ResourceFacts, SiteFacts } from "../facts/types.ts";
import { parseCacheControl, parseLink } from "../facts/headers.ts";
import { evidence } from "../facts/read-note.ts";
import { log } from "../logger.ts";
import { clockRules } from "./clock.ts";
import { deprecatedRules } from "./deprecated.ts";
import { disclosureRules } from "./disclosure.ts";
import { i18nRules } from "./i18n.ts";
import { cachingRules } from "./caching.ts";
import { insightRules, partition } from "./insights.ts";
import { lengthRules } from "./length.ts";
import { said } from "./message.ts";
import { relationRules } from "./relations.ts";
import { robotsRules } from "./robots.ts";
import { urlRules } from "./url.ts";
import type { Finding, Make, RuleMeta, Severity } from "./types.ts";

// Every in-scope page answering 4xx, 5xx or nothing, with the pages that link to it.
const brokenInternal: Make = (severity) => ({
    meta: { id: "links/broken-internal", severity, scope: "site", facts: ["http.status", "crawl.referrers"], docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors", fix: "Fix the page at the link target so it answers 2xx, or point the links to a working URL." },
    check(pages: Facts[]) {
        const findings: Finding[] = [];
        for (const page of pages) {
            if (page.http.status > 0 && page.http.status < 400) continue;
            log.debug({ url: page.url.href, status: page.http.status, referrers: page.crawl.referrers.length }, "broken link");
            findings.push({
                rule: "links/broken-internal",
                severity,
                scope: "site",
                url: page.url.href,
                ...(page.http.error ? said("the page could not be fetched: {error}; linked from these pages", { error: page.http.error }) : said("the page answers {status}; linked from these pages", { status: String(page.http.status) })),
                value: page.http.status,
                urls: page.crawl.referrers,
            });
        }
        return findings;
    },
});

// Every probed external link answering 4xx or 5xx, or nothing, once per target, with the pages linking to it; a 429, a bot wall, an excluded host or a refused address is not judged.
const brokenExternal: Make = (severity) => ({
    meta: { id: "links/broken-external", severity, scope: "site", facts: ["site.links", "html.links.external"], docs: "https://developer.mozilla.org/docs/Web/HTTP/Reference/Status/404", fix: "Remove or repoint each broken external link." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const answers = site?.links ?? {};
        const linking = new Map<string, string[]>();
        for (const page of pages) {
            const hrefs = page.html?.links.external ?? [];
            for (const href of hrefs) linking.set(href, [...(linking.get(href) ?? []), page.url.href]);
        }
        const findings: Finding[] = [];
        for (const [href, urls] of linking) {
            const answer = answers[href];
            const isBroken = answer !== undefined && isJudged(answer) && (answer.status === 0 || answer.status >= 400);
            log.debug({ rule: "links/broken-external", url: href, status: answer?.status, excluded: answer?.excluded, refused: answer?.refused, walled: answer?.walled, isBroken }, "external link judged");
            if (!isBroken) continue;
            const verdict = answer.status === 0 ? said("the link could not be reached: {error}; linked from these pages", { error: answer.error ?? "" }) : said("the link answers {status}; linked from these pages", { status: String(answer.status) });
            findings.push({ rule: "links/broken-external", severity, scope: "site", url: href, ...verdict, evidence: [evidence("probes", href, { ...(answer.checked && { at: answer.checked }) })], value: answer.status, urls });
        }
        return findings;
    },
});

// Every sitemap image or video answering 4xx or 5xx, or nothing, once per file, with the pages listing it.
const sitemapMedia: Make = (severity) => ({
    meta: { id: "sitemap/media", severity, scope: "site", facts: ["sitemap.images", "sitemap.videos", "site.links"], docs: "https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps", fix: "Remove or repoint each sitemap image and video entry that no longer answers 200." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const listing = new Map<string, string[]>();
        for (const page of pages) for (const href of mediaOf(page)) listing.set(href, [...(listing.get(href) ?? []), page.url.href]);
        const findings: Finding[] = [];
        for (const [href, urls] of listing) {
            const answer = site?.links?.[href];
            const isBroken = answer !== undefined && isJudged(answer) && (answer.status === 0 || answer.status >= 400);
            log.debug({ rule: "sitemap/media", url: href, status: answer?.status, isBroken }, "sitemap media judged");
            if (!isBroken) continue;
            const verdict = answer.status === 0 ? said("the sitemap media could not be reached: {error}; listed by these pages", { error: answer.error ?? "" }) : said("the sitemap media answers {status}; listed by these pages", { status: String(answer.status) });
            findings.push({ rule: "sitemap/media", severity, scope: "site", url: href, ...verdict, value: answer.status, urls });
        }
        return findings;
    },
});

// Every internal link answering with a redirect, once per target, with the pages linking to it.
const redirectedInternal: Make = (severity) => ({
    meta: { id: "links/redirected-internal", severity, scope: "site", facts: ["site.redirects", "html.links.internal"], docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects", fix: "Make the link target point at the final URL, or serve the content directly." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const landing = new Map(Object.entries(site?.redirects ?? {}));
        const linking = new Map<string, string[]>();
        for (const page of pages) {
            const hrefs = new Set(page.html?.links.internal);
            for (const href of hrefs) if (landing.has(href)) linking.set(href, [...(linking.get(href) ?? []), page.url.href]);
        }
        log.debug({ rule: "links/redirected-internal", redirecting: landing.size, linked: linking.size }, "internal redirects judged");
        return linking
            .entries()
            .map(([href, urls]) => ({ rule: "links/redirected-internal", severity, scope: "site" as const, url: href, ...said("the link redirects elsewhere; linked from these pages"), data: { [href]: { landing: landing.get(href) as string } }, value: landing.get(href), urls }))
            .toArray();
    },
});

// Every sitemap file that failed to fetch, failed to parse, or named no URL.
const sitemapUnreadable: Make = (severity) => ({
    meta: { id: "sitemap/unreadable", severity, scope: "site", facts: ["site.sitemaps"], docs: "https://www.sitemaps.org/protocol.html", fix: "Serve the sitemap at its listed URL and make sure it parses as XML or plain text with one URL per line." },
    check(_pages: Facts[], _group?: string, site?: SiteFacts) {
        const files = site?.sitemaps ?? [];
        log.debug({ rule: "sitemap/unreadable", files: files.length }, "sitemap files judged");
        return files.filter((file) => file.error).map((file) => ({ rule: "sitemap/unreadable", severity, scope: "site" as const, url: file.url, ...said("the sitemap could not be read"), data: { [file.url]: { error: file.error as string } }, value: file.status }));
    },
});

// A header's value, repeated fields joined; absent is empty.
export function header(page: Facts, name: string): string {
    const value = page.http.headers[name] ?? "";
    return Array.isArray(value) ? value.join(", ") : value;
}

// Framing refused by CSP `frame-ancestors` or by `X-Frame-Options` DENY or SAMEORIGIN.
const frameOptions: Make = (severity) => ({
    meta: {
        id: "http/frame-options",
        severity,
        scope: "page",
        facts: ["http.csp.directives", "http.headers.x-frame-options"],
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors",
        fix: "Send a Content-Security-Policy frame-ancestors directive, or X-Frame-Options: DENY.",
    },
    check(page: Facts) {
        const hasAncestors = page.http.csp?.directives?.["frame-ancestors"] !== undefined;
        const options = header(page, "x-frame-options").trim();
        const isDenied = hasAncestors || /^(?:deny|sameorigin)$/i.test(options);
        log.debug({ rule: "http/frame-options", url: page.url.href, hasAncestors, options, isDenied }, "framing checked");
        return isDenied
            ? []
            : [
                  {
                      rule: "http/frame-options",
                      severity,
                      scope: "page" as const,
                      url: page.url.href,
                      group: page.group,
                      ...said("neither content-security-policy frame-ancestors nor x-frame-options refuses framing"),
                      ...(options && { data: { [page.url.href]: { "x-frame-options": options } } }),
                      value: options || undefined,
                  },
              ];
    },
});

// Parsed `Link` entries, empty when the value breaks RFC 8288.
const linksOf = (parsed: ParsedHeader | undefined): Record<string, string>[] => (parsed?.value as Record<string, string>[] | undefined) ?? [];

// Absolute targets of the entries carrying relation token `relation`.
function targets(links: Record<string, string>[], relation: string, base: string): string[] {
    return links.filter((link) => (link.rel ?? "").split(/\s+/).includes(relation)).map((link) => resolve(link.href ?? "", base));
}

// Absolute targets of the `Link` entries carrying relation token `relation`.
export function linkTargets(raw: string, relation: string, base: string): string[] {
    return targets(linksOf(parseLink(raw)), relation, base);
}

// A preload a 103 hinted that the final response’s `Link` no longer carries.
const earlyHintsPreload: Make = (severity) => ({
    meta: { id: "http/early-hints-preload", severity, scope: "page", facts: ["http.early-hints", "http.parsed.link"], docs: "https://developer.mozilla.org/docs/Web/HTTP/Status/103", fix: "Remove the preload from the 103 Early Hints, or add it to the final Link header." },
    check(page: Facts) {
        const hints = page.http["early-hints"];
        const parsed = page.http.parsed?.link;
        if (!hints || (parsed?.errors.length ?? 0) > 0) return;
        const final = new Set(targets(linksOf(parsed), "preload", page.url.href));
        const dropped = [...new Set(hints.flatMap((hint) => linkTargets(hint.link ?? "", "preload", page.url.href))).difference(final)];
        log.debug({ rule: "http/early-hints-preload", url: page.url.href, hints: hints.length, final: final.size, dropped: dropped.length }, "early hints compared");
        return dropped.length === 0 ? [] : [{ rule: "http/early-hints-preload", severity, scope: "page" as const, url: page.url.href, group: page.group, ...said("a 103 Early Hints preload is missing from the final Link header"), data: { [page.url.href]: { preloads: dropped.join(", ") } }, value: dropped }];
    },
});

type HeadLink = HtmlFacts["head"]["links"][number];

// The origin of an http(s) URL, else undefined.
function originOf(href: string | undefined): string | undefined {
    if (!href || !URL.canParse(href)) return undefined;
    const url = new URL(href);
    return /^https?:$/.test(url.protocol) ? url.origin : undefined;
}

// Head links and `Link` header entries whose `rel` carries one of `relations`.
function withRelation(page: Facts, relations: string[]): HeadLink[] {
    const headers = linksOf(page.http.parsed?.link).map((link): HeadLink => ({ ...link, href: resolve(link.href ?? "", page.url.href) }));
    return [...(page.html?.head.links ?? []), ...headers].filter((link) =>
        (link.rel ?? "")
            .toLowerCase()
            .split(/\s+/)
            .some((token) => relations.includes(token)),
    );
}

// Origins warmed by `preconnect` or `dns-prefetch`, with the relation that names each.
function hintedOrigins(page: Facts): Map<string, string> {
    return new Map(withRelation(page, ["preconnect", "dns-prefetch"]).flatMap((link) => (originOf(link.href) ? [[originOf(link.href) as string, (link.rel ?? "").toLowerCase()]] : [])));
}

// A hinted origin no resource of the rendered page loads; a static parse misses what CSS and scripts load, so only a browser census is judged.
const preconnectUnused = pageRule(
    "html/preconnect-unused",
    ["html.head.links", "http.parsed.link", "resources"],
    (page) => {
        if (!page.browser || !page.html) return;
        const used = new Set((page.resources ?? []).map((resource) => originOf(resource.url)));
        const unused = hintedOrigins(page)
            .entries()
            .filter(([origin]) => !used.has(origin))
            .toArray();
        log.debug({ rule: "html/preconnect-unused", url: page.url.href, used: used.size, unused: unused.length }, "resource hints matched");
        return unused.map(([origin, relation]) => ({ ...said("rel={relation} warms an origin that no resource of the page loads", { relation }), data: { [page.url.href]: { origin } }, value: origin }));
    },
    { docs: "https://developer.mozilla.org/docs/Web/HTML/Reference/Attributes/rel/preconnect", fix: "Remove the preconnect or dns-prefetch link to an origin the page no longer loads from." },
);

// Viewport meta keys with the values browsers read; any other key or value is dropped quietly.
const VIEWPORT: Record<string, RegExp> = {
    width: /^(?:device-width|\d+(?:\.\d+)?)$/i,
    height: /^(?:device-height|\d+(?:\.\d+)?)$/i,
    "initial-scale": /^\d*\.?\d+$/,
    "minimum-scale": /^\d*\.?\d+$/,
    "maximum-scale": /^\d*\.?\d+$/,
    "user-scalable": /^(?:yes|no|\d*\.?\d+)$/i,
    "viewport-fit": /^(?:auto|contain|cover)$/i,
    "interactive-widget": /^(?:resizes-visual|resizes-content|overlays-content)$/i,
};

// Each viewport entry a browser drops: an unknown key, a value it cannot read, or a key without `=`.
const viewportSyntax = pageRule(
    "html/viewport-syntax",
    ["html.meta.viewport"],
    (page) => {
        const content = page.html?.meta.viewport;
        if (content === undefined) return;
        const entries = content
            .replaceAll(/\s*=\s*/g, "=")
            .split(/[\s,;]+/)
            .filter((entry) => entry.length > 0);
        const dropped = entries.filter((entry) => {
            const [key = "", value] = entry.split("=", 2);
            return value === undefined || !VIEWPORT[key.toLowerCase()]?.test(value);
        });
        log.debug({ rule: "html/viewport-syntax", url: page.url.href, entries: entries.length, dropped: dropped.length }, "viewport entries read");
        return dropped.map((entry) => ({ ...said("a meta viewport entry is not a key and value browsers read, so they ignore it"), data: { [page.url.href]: { entry } }, value: entry }));
    },
    { docs: "https://drafts.csswg.org/css-viewport/#viewport-meta", fix: "Keep meta viewport to known keys, as in width=device-width, initial-scale=1." },
);

// Each meta theme-color whose content is no CSS <color>, which browsers then ignore; css-tree loads on first use.
const themeColorSyntax = pageRule(
    "html/theme-color-syntax",
    ["html.metas"],
    (page) => {
        const colors = page.html?.metas.filter((meta) => meta.name.toLowerCase() === "theme-color");
        if (!colors?.length) return;
        const { lexer } = createRequire(import.meta.url)("css-tree") as typeof import("css-tree");
        const invalid = colors.filter((meta) => !lexer.match("<color>", meta.content.trim()).matched);
        log.debug({ rule: "html/theme-color-syntax", url: page.url.href, colors: colors.length, invalid: invalid.length }, "theme colors read");
        return invalid.map((meta) => ({ ...(meta.content.trim() === "" ? said("meta theme-color is empty, so browsers ignore it") : { ...said("meta theme-color is not a CSS color, so browsers ignore it"), data: { [page.url.href]: { content: meta.content } } }), value: meta.content }));
    },
    { docs: "https://html.spec.whatwg.org/multipage/semantics.html#meta-theme-color", fix: "Set <meta name=theme-color> content to a CSS color, as in #1a73e8." },
);

// Cross origins serving a head script without `async`, `defer` or `type=module`, or a style sheet for every medium.
function blockingOrigins(page: Facts): Map<string, string> {
    const scripts = (page.html?.scripts ?? []).filter((script) => script.head && !script.async && !script.defer && script.type !== "module").map((script) => [originOf(script.src), "script"]);
    const styles = withRelation(page, ["stylesheet"])
        .filter((link) => !link.media || /\b(?:all|screen)\b/i.test(link.media))
        .map((link) => [originOf(link.href), "style sheet"]);
    return new Map([...scripts, ...styles].filter((entry): entry is [string, string] => entry[0] !== undefined && entry[0] !== page.url.origin));
}

// A cross origin serving a render-blocking resource with no `preconnect`, `dns-prefetch` or `preload` towards it.
const preconnectMissing = pageRule(
    "html/preconnect-missing",
    ["html.head.links", "http.parsed.link", "html.scripts"],
    (page) => {
        if (!page.html) return;
        const warmed = new Set([...hintedOrigins(page).keys(), ...withRelation(page, ["preload"]).map((link) => originOf(link.href))]);
        const cold = blockingOrigins(page)
            .entries()
            .filter(([origin]) => !warmed.has(origin))
            .toArray();
        log.debug({ rule: "html/preconnect-missing", url: page.url.href, warmed: warmed.size, cold: cold.length }, "render-blocking origins matched");
        return cold.map(([origin, kind]) => ({ ...said("an origin serves a render-blocking {kind} and nothing preconnects to it", { kind }), data: { [page.url.href]: { origin } }, value: origin }));
    },
    { docs: "https://web.dev/articles/preconnect-and-dns-prefetch", fix: 'Add <link rel="preconnect" href="https://origin.example"> for each cross origin a render-blocking script or style sheet comes from.' },
);

// A `preconnect` to an origin serving fonts that lacks `crossorigin`, so the font fetch opens a second connection.
const preconnectCrossorigin = pageRule(
    "html/preconnect-crossorigin",
    ["html.head.links", "http.parsed.link", "resources"],
    (page) => {
        if (!page.html) return;
        const fonts = new Set([
            ...(page.resources ?? []).filter((resource) => resource.kind === "font").map((resource) => originOf(resource.url)),
            ...withRelation(page, ["preload"])
                .filter((link) => link.as === "font")
                .map((link) => originOf(link.href)),
        ]);
        const preconnects = withRelation(page, ["preconnect"]).filter((link) => originOf(link.href) !== undefined && fonts.has(originOf(link.href)));
        const anonymous = new Set(preconnects.filter((link) => link.crossorigin !== undefined).map((link) => originOf(link.href)));
        const bare = [...new Set(preconnects.map((link) => originOf(link.href))).difference(anonymous)];
        log.debug({ rule: "html/preconnect-crossorigin", url: page.url.href, fonts: fonts.size, preconnects: preconnects.length, bare: bare.length }, "font preconnects matched");
        return bare.map((origin) => ({ ...said("the preconnect to a font origin lacks crossorigin, so fonts open a second connection"), data: { [page.url.href]: { origin: String(origin) } }, value: origin }));
    },
    { docs: "https://developer.mozilla.org/docs/Web/HTML/Reference/Attributes/rel/preconnect", fix: "Add the crossorigin attribute to the preconnect link towards the origin fonts load from." },
);

// Fragment-free absolute form of a URL relative to the page; an unparsable value stays as written.
export function resolve(raw: string, base: string): string {
    if (!URL.canParse(raw, base)) return raw;
    const url = new URL(raw, base);
    url.hash = "";
    return url.href;
}

// A page whose `fact` names a URL other than its own or its twin on the canonical origin; a page without the fact is skipped.
function pointsHere(id: string, fact: string, label: string, read: (html: HtmlFacts) => string | undefined, guide: Guide = {}): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts: [fact], ...guide },
        check(page: Facts) {
            const raw = page.html && read(page.html);
            if (raw === undefined) return;
            const target = resolve(raw, page.url.href);
            const here = [page.url.href, page.url.twin].flatMap((href) => (href ? [resolve(href, href)] : []));
            const matches = here.includes(target);
            log.debug({ rule: id, url: page.url.href, twin: page.url.twin, target, matches }, "self reference checked");
            return matches ? [] : [{ rule: id, severity, scope: "page" as const, url: page.url.href, group: page.group, ...said("{label} names another URL, not this page", { label }), data: { [page.url.href]: { target } }, value: raw }];
        },
    });
}

// Per-connection facts that should not differ between pages of one host.
const ORIGIN: [string, string, (page: Facts) => string | undefined][] = [
    ["tls.cert.fingerprint256", "certificate fingerprint", (page) => page.tls?.cert.fingerprint256],
    ["tls.protocol", "TLS version", (page) => page.tls?.protocol],
    ["http.remote.address", "server address", (page) => page.http.remote?.address],
    ["http.headers.server", "Server header", (page) => header(page, "server") || undefined],
];

// The finding for one host and fact when its value varies across the host's pages.
function varies(severity: Exclude<Severity, "off">, host: string, members: Facts[], fact: string, label: string, read: (page: Facts) => string | undefined): Finding | undefined {
    const byValue = partition(members, read);
    log.debug({ rule: "http/consistent-origin", host, fact, values: byValue.size }, "origin fact compared");
    if (byValue.size < 2) return undefined;
    const entries = byValue.entries().toArray();
    const urls = entries.flatMap(([, group]) => group.map((page) => page.url.href));
    const data = Object.fromEntries(entries.flatMap(([value, group]) => group.map((page) => [page.url.href, { value }])));
    return { rule: "http/consistent-origin", severity, scope: "site", url: urls[0] as string, ...said("{label} varies across {host}", { label, host }), data, value: Object.fromEntries(entries.map(([value, group]) => [value, group.length])), urls };
}

// One finding per host and fact whose value varies across its pages, with the URL count per value.
const consistentOrigin: Make = (severity) => ({
    meta: { id: "http/consistent-origin", severity, scope: "site", facts: ORIGIN.map(([fact]) => fact), fix: "Make every page of the host serve the same certificate, TLS protocol and Server header." },
    check(pages: Facts[]) {
        const hosts = Map.groupBy(pages, (page) => page.url.host)
            .entries()
            .toArray();
        return hosts.flatMap(([host, members]) => ORIGIN.map(([fact, label, read]) => varies(severity, host, members, fact, label, read)).filter((finding) => finding !== undefined));
    },
});

// A resource’s finding, with the values measured at it under its URL.
export type Verdict = (resource: ResourceFacts) => Offence | undefined;

// A rule's docs link and one-line fix.
export type Guide = Pick<RuleMeta, "docs" | "fix">;

// What one page finding says; the rule fills in the rest.
export type Offence = Pick<Finding, "message" | "text" | "variables" | "data" | "evidence" | "value" | "locations">;

// A page rule: one finding per offence `judge` returns, none when empty, skipped when undefined.
export function pageRule(id: string, facts: string[], judge: (page: Facts) => Offence[] | undefined, guide: Guide = {}): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts, ...guide },
        check(page: Facts) {
            const offences = judge(page);
            log.debug({ rule: id, url: page.url.href, offences: offences?.length }, "page judged");
            return offences?.map((offence) => ({ rule: id, severity, scope: "page" as const, url: page.url.href, group: page.group, ...offence }));
        },
    });
}

// A site rule keyed by resource URL: one finding per offending resource, its pages as `urls`.
export function resourceRule(id: string, isUsed: (page: Facts, resource: ResourceFacts) => boolean, verdict: Verdict, facts = ["resources"], valueOf = (resource: ResourceFacts): unknown => resource.http?.status, guide: Guide = {}): Make {
    return (severity) => ({
        meta: { id, severity, scope: "site", facts, ...guide },
        check(pages: Facts[]) {
            const usedBy = new Map<string, { resource: ResourceFacts; urls: string[] }>();
            const uses = pages.flatMap((page) => (page.resources ?? []).filter((resource) => isUsed(page, resource)).map((resource) => ({ page, resource })));
            for (const { page, resource } of uses) {
                const entry = usedBy.get(resource.url) ?? { resource, urls: [] };
                entry.urls.push(page.url.href);
                usedBy.set(resource.url, entry);
            }
            const findings: Finding[] = [];
            for (const [url, { resource, urls }] of usedBy) {
                const judged = verdict(resource);
                log.debug({ rule: id, resource: url, pages: urls.length, isFinding: judged !== undefined }, "resource judged");
                if (judged) findings.push({ rule: id, severity, scope: "site", url, ...judged, value: valueOf(resource), urls });
            }
            return findings;
        },
    });
}

const isAnyUse = () => true;

// A fetched resource answering outside 2xx, or not at all.
const resourceStatus: Verdict = (resource) => {
    const http = resource.http;
    if (!http || (http.status >= 200 && http.status < 300)) return;
    return http.status === 0 ? said("{kind} could not be fetched: {error}; used by these pages", { kind: resource.kind, error: http.error ?? "" }) : said("{kind} answers {status}; used by these pages", { kind: resource.kind, status: String(http.status) });
};

// A resource header's value, repeated fields joined; absent is empty.
function resourceHeader(resource: ResourceFacts, name: string): string {
    return [resource.http?.headers[name] ?? []].flat().join(", ");
}

// A resource that answered 2xx.
function isServed(resource: ResourceFacts): boolean {
    const status = resource.http?.status ?? 0;
    return status >= 200 && status < 300;
}

// One year, the `max-age` a fingerprinted asset can carry.
const YEAR = 31_536_000;

// A file name carrying a content hash: a `.` or `-` segment of 8+ word characters with a digit, before the extension.
const HASHED = /[.-](?=[\w-]*\d)[\w-]{8,}\.\w+$/;

// A fingerprinted or `immutable` asset whose `Cache-Control` keeps it for less than a year.
const resourceCacheControl: Verdict = (resource) => {
    const policy = resourceHeader(resource, "cache-control");
    const isImmutable = /\bimmutable\b/i.test(policy);
    const isHashed = HASHED.test(new URL(resource.url).pathname);
    if (!isServed(resource) || (!isImmutable && !isHashed)) return;
    const { value, errors } = parseCacheControl(policy);
    const directives = (value ?? {}) as Record<string, unknown>;
    const maxAge = Number(directives["max-age"] ?? 0);
    const isLong = maxAge >= YEAR && !directives["no-cache"] && !directives["no-store"];
    log.debug({ rule: "resources/cache-control", resource: resource.url, isImmutable, isHashed, maxAge, isLong, errors }, "resource cache policy judged");
    const variables = { kind: resource.kind };
    if (errors.length > 0) return { ...said(isHashed ? "fingerprinted {kind} sends a Cache-Control that breaks RFC 9111; used by these pages" : "immutable {kind} sends a Cache-Control that breaks RFC 9111; used by these pages", variables), data: { [resource.url]: { errors: errors.join("; ") } } };
    return isLong ? undefined : { ...said(isHashed ? "fingerprinted {kind} is cached for less than a year; used by these pages" : "immutable {kind} is cached for less than a year; used by these pages", variables), data: { [resource.url]: { "max-age": maxAge, ...(policy && { "cache-control": policy }) } } };
};

// Text formats worth compressing, fonts other than WOFF and WOFF2 included.
const TEXT = /^(?:text\/|image\/svg\+xml|application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|ecmascript|wasm|vnd\.ms-fontobject|x-font-(?:ttf|otf)|font-sfnt)|font\/(?:ttf|otf|sfnt|collection))/;

// A text asset over 1 KB answered without br, gzip or zstd.
const resourceCompression: Verdict = (resource) => {
    const type = resource.http?.["content-type"] ?? "";
    const coding = resourceHeader(resource, "content-encoding");
    const isText = TEXT.test(type) && (resource.http?.size.body ?? 0) >= 1024;
    const isCompressed = /\b(?:br|gzip|zstd)\b/i.test(coding);
    log.debug({ rule: "resources/compression", resource: resource.url, type, coding, isText, isCompressed }, "resource compression judged");
    return isText && !isCompressed && isServed(resource) ? { ...said("a text {kind} is not served with br, gzip or zstd; used by these pages", { kind: resource.kind }), data: { [resource.url]: { type, ...(coding && { "content-encoding": coding }) } } } : undefined;
};

// Values in quotes, comma separated; none when empty.
const quoted = (values: string[]): string => (values.length === 0 ? "none" : values.map((value) => `“${value}”`).join(", "));

// Served declarations a script changed once the page rendered, each as its tag, served value and rendered value; an unrendered page is skipped.
const declarationRewritten = pageRule(
    "html/declaration-rewritten",
    ["html.rewritten"],
    (page) => {
        if (!page.parity) return;
        const rewritten = page.html?.rewritten ?? [];
        return rewritten.length === 0
            ? []
            : [{ ...said("a script changes declarations the served HTML makes; rules judge the served ones"), data: { [page.url.href]: { declarations: rewritten.length } }, value: rewritten, locations: rewritten.map((entry) => `${entry.tag} served ${quoted(entry.served)}, rendered ${quoted(entry.rendered)}`) }];
    },
    { docs: "https://html.spec.whatwg.org/multipage/semantics.html#the-meta-element", fix: "Serve each declaration with its final value, so readers that run no script see what the page means." },
);

// TypeScript rules a preset enables by ID alone.
export const builtin: Record<string, Make> = {
    "links/broken-internal": brokenInternal,
    "links/redirected-internal": redirectedInternal,
    "links/broken-external": brokenExternal,
    "http/frame-options": frameOptions,
    "html/declaration-rewritten": declarationRewritten,
    "http/early-hints-preload": earlyHintsPreload,
    "html/preconnect-unused": preconnectUnused,
    "html/preconnect-missing": preconnectMissing,
    "html/preconnect-crossorigin": preconnectCrossorigin,
    "html/viewport-syntax": viewportSyntax,
    "html/theme-color-syntax": themeColorSyntax,
    "http/consistent-origin": consistentOrigin,
    "sitemap/unreadable": sitemapUnreadable,
    "sitemap/media": sitemapMedia,
    ...robotsRules,
    ...i18nRules,
    ...disclosureRules,
    ...deprecatedRules,
    ...clockRules,
    ...urlRules,
    ...insightRules,
    ...cachingRules,
    ...lengthRules,
    ...relationRules,
    "resources/status": resourceRule(
        "resources/status",
        (_page, resource) => resource.kind !== "enclosure",
        resourceStatus,
        undefined,
        (resource) => resource.http?.status ?? 0,
        { docs: "https://developer.mozilla.org/docs/Web/HTTP/Reference/Status", fix: "Fix the resource server so it answers 2xx, or remove the resource from the page." },
    ),
    "resources/mixed-content": resourceRule(
        "resources/mixed-content",
        (page, resource) => page.url.protocol === "https:" && resource.url.startsWith("http:"),
        (resource) => said("{kind} loads over http: on the https: pages that use it", { kind: resource.kind }),
        undefined,
        undefined,
        { docs: "https://developer.mozilla.org/docs/Web/Security/Mixed_content", fix: "Load the resource over https instead of http." },
    ),
    "resources/sri": resourceRule(
        "resources/sri",
        (_page, resource) => resource.origin === "cross" && (resource.kind === "script" || resource.kind === "style"),
        (resource) => (resource.integrity ? undefined : said("cross-origin {kind} without integrity; used by these pages", { kind: resource.kind })),
        undefined,
        undefined,
        { docs: "https://developer.mozilla.org/docs/Web/Security/Subresource_Integrity", fix: "Add an integrity attribute (sha384 or sha256) and crossorigin=anonymous to each cross-origin script and style sheet." },
    ),
    "resources/cache-control": resourceRule("resources/cache-control", isAnyUse, resourceCacheControl, undefined, (resource) => resource.http?.headers["cache-control"], {
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Caching#cache_busting",
        fix: "Send Cache-Control: public, max-age=31536000, immutable with every fingerprinted asset.",
    }),
    "resources/compression": resourceRule("resources/compression", isAnyUse, resourceCompression, undefined, (resource) => resource.http?.headers["content-encoding"], {
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Compression",
        fix: "Serve text assets br, zstd or gzip to every client whose Accept-Encoding offers one.",
    }),
    "html/canonical-self": pointsHere("html/canonical-self", "html.canonical", "canonical link", (html) => html.canonical, { docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls", fix: "Point <link rel=canonical> at this page’s own URL." }),
    "html/og-url-self": pointsHere("html/og-url-self", "html.property.og:url", "og:url", (html) => html.property["og:url"], { docs: "https://ogp.me/#metadata", fix: "Point <meta property=og:url> at this page’s own URL." }),
};
