// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { getDomain } from "tldts";
import { reason } from "../crawl/fetch.ts";
import { RobotsDisallowed, type Probe } from "../crawl/probe.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "../rules/types.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

// Stack trace shapes of the common server runtimes.
const TRACE = /Traceback \(most recent call last\)|^\s+at \S.*:\d+:\d+\)?$|Stack trace:|Exception in thread|Fatal error: .* on line \d+/m;

// Languages `/` is fetched in; spread across scripts and directions so one special-cased locale shows.
const LANGUAGES = ["en", "uk", "ja", "ar"];

// Codings `/` should be offered in, each asked for alone.
const CODINGS = ["br", "zstd", "gzip"];

// A response’s media type without parameters.
export function mediaType(answer: Probe): string {
    return String(answer.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

// The answer to a random path, logged so an owner can find it in their access log.
const notFound: SiteExtractor = {
    id: "not-found",
    per: "origin",
    async extract(origin, context) {
        const url = `${origin}/spiderlint-${randomUUID()}`;
        log.info({ url }, "missing page probed");
        const answer = await context.fetch(url, { redirect: "manual" });
        const server = answer.headers.server;
        const location = answer.headers.location;
        return { url, status: answer.status, "content-type": mediaType(answer), bytes: Buffer.byteLength(answer.body), trace: TRACE.test(answer.body), ...(typeof server === "string" && { server }), ...(typeof location === "string" && { location }) };
    },
};

// The first answer of plain http on the origin’s host, and whether it redirects to `https://<host>/`; an onion or I2P service is skipped.
const entry: SiteExtractor = {
    id: "entry",
    per: "origin",
    async extract(origin, context) {
        const { protocol, hostname, host } = new URL(origin);
        if (hostname.endsWith(".onion") || hostname.endsWith(".i2p")) return;
        const url = `http://${protocol === "http:" ? host : hostname}/`;
        try {
            const answer = await context.fetch(url, { redirect: "manual" });
            const location = answer.headers.location;
            const target = typeof location === "string" && URL.canParse(location, url) ? new URL(location, url).href : undefined;
            log.debug({ url, status: answer.status, target }, "plain http entry probed");
            return { url, status: answer.status, https: target === `https://${hostname}/`, ...(target && { location: target }) };
        } catch (error) {
            if (error instanceof RobotsDisallowed) throw error;
            log.debug({ url, error: reason(error) }, "plain http entry unreachable");
            return { url, error: reason(error) };
        }
    },
};

// Hops an entry variant is followed through by hand.
const MAX_ENTRY_HOPS = 5;

// Statuses a moved entry may answer with.
const PERMANENT = new Set([301, 308]);

// One entry variant: the `[status, location]` hops, the URL it ends on, and whether its name resolves at all.
export interface Variant {
    url: string;
    chain: [number, string][];
    final: string;
    resolves: boolean;
    error?: string;
}

// `hostname` with its `www.` label added to an apex or stripped from `www.<apex>`; any other name has none.
export function swapped(hostname: string): string | undefined {
    const domain = getDomain(hostname, { allowPrivateDomains: true });
    if (!domain) return undefined;
    if (hostname === domain) return `www.${domain}`;
    return hostname === `www.${domain}` ? domain : undefined;
}

// Where an answer sends its reader: a 3xx `Location`, or a 2xx HTML meta refresh.
function sentTo(answer: Probe, url: string): string | undefined {
    const location = answer.headers.location;
    const isMoved = answer.status >= 300 && answer.status < 400 && typeof location === "string";
    const refresh = !isMoved && answer.status >= 200 && answer.status < 300 && mediaType(answer) === "text/html" ? load(answer.body)('meta[http-equiv="refresh" i]').attr("content") : undefined;
    const href = isMoved ? location : /url\s*=\s*['"]?([^'"\s]+)/i.exec(refresh ?? "")?.[1];
    return href && URL.canParse(href, url) ? new URL(href, url).href : undefined;
}

// `href` followed hop by hop; a name with no DNS answer does not resolve, and any other failure, TLS included, is its error.
async function walk(href: string, context: SiteContext): Promise<Variant> {
    const chain: Variant["chain"] = [];
    let url = href;
    try {
        for (let hop = 0; hop <= MAX_ENTRY_HOPS; hop += 1) {
            const answer = await context.delegated(url, { redirect: "manual" });
            const next = sentTo(answer, url);
            log.debug({ href, url, status: answer.status, next, hop }, "entry variant hop");
            if (!next) return { url: href, chain, final: url, resolves: true };
            chain.push([answer.status, next]);
            url = next;
        }
        return { url: href, chain, final: url, resolves: true, error: `more than ${MAX_ENTRY_HOPS} hops` };
    } catch (error) {
        if (error instanceof RobotsDisallowed && !error.unreachable) throw error;
        const why = error instanceof RobotsDisallowed ? (error.unreachable as string) : reason(error);
        const isUnresolved = chain.length === 0 && /\bENOTFOUND\b/.test(why);
        log.debug({ href, url, hops: chain.length, isUnresolved, error: why }, "entry variant stopped");
        return { url: href, chain, final: url, resolves: !isUnresolved, ...(!isUnresolved && { error: why }) };
    }
}

// A URL’s path and query.
function pathOf(href: string): string {
    const { pathname, search } = new URL(href);
    return pathname + search;
}

// Whether a variant takes one hop, or the two HSTS preload asks for: http to https on its own host first.
function isShort(variant: Variant): boolean {
    const [first] = variant.chain;
    return variant.chain.length <= 1 || (variant.chain.length === 2 && variant.url.startsWith("http:") && first?.[1] === variant.url.replace(/^http:/, "https:"));
}

// Whether a variant is sent from https to plain http anywhere on its way.
function isDowngraded(variant: Variant): boolean {
    const steps = [variant.url, ...variant.chain.map(([, location]) => location)];
    return steps.some((step, index) => step.startsWith("https:") && steps[index + 1]?.startsWith("http:"));
}

// Every entry variant of the origin: http and https, on its host and its `www.` twin, at `/` and at the seed path with a marked query.
const variants: SiteExtractor = {
    id: "variants",
    per: "origin",
    async extract(origin, context) {
        const { protocol, hostname, port } = new URL(origin);
        if (hostname.endsWith(".onion") || hostname.endsWith(".i2p")) return;
        const hosts = [hostname, swapped(hostname) ?? []].flat();
        const schemes = port ? [protocol] : ["http:", "https:"];
        const seed = context.pages.find((page) => page.crawl["discovered-via"] === "seed") ?? context.pages[0];
        const deep = `${seed?.url.pathname ?? "/"}?spiderlint=${randomUUID()}`;
        const urls = [...new Set(["/", deep].flatMap((path) => hosts.flatMap((host) => schemes.map((scheme) => `${scheme}//${host}${port ? `:${port}` : ""}${path}`))))];
        log.info({ origin, urls }, "entry variants probed");
        const settled = await Promise.all(urls.map(async (url) => {
            try {
                return await walk(url, context);
            } catch (error) {
                if (!(error instanceof RobotsDisallowed)) throw error;
                log.info({ url, error: reason(error) }, "robots.txt withholds the entry variant");
                return;
            }
        }));
        const probes = settled.filter((variant) => variant !== undefined);
        const landed = probes.filter((variant) => variant.resolves && !variant.error);
        return {
            probes,
            unresolved: [...new Set(probes.filter((variant) => !variant.resolves).map((variant) => new URL(variant.url).hostname))],
            long: landed.filter((variant) => !isShort(variant)).map((variant) => variant.url),
            temporary: probes.filter((variant) => variant.chain.some(([status]) => !PERMANENT.has(status))).map((variant) => variant.url),
            dropped: landed.filter((variant) => pathOf(variant.final) !== pathOf(variant.url)).map((variant) => variant.url),
            downgraded: probes.filter((variant) => isDowngraded(variant)).map((variant) => variant.url),
        };
    },
};

// The origin `subject`’s variants must land on: the canonical origin its pages twin to when that is on its host or `www.` twin, else itself.
export function canonicalOf(subject: string, pages: readonly Facts[]): string {
    const twin = pages.find((page) => page.url.origin === subject && page.url.twin)?.url.twin;
    const { hostname } = new URL(subject);
    const candidate = twin ? new URL(twin).origin : subject;
    return [hostname, swapped(hostname)].includes(new URL(candidate).hostname) ? candidate : subject;
}

// One finding per origin naming each resolving variant that fails or ends off the canonical origin.
const hostCanonical: Make = (severity) => ({
    meta: { id: "origin/host-canonical", severity, scope: "site", facts: ["site.origins.*.variants.probes"], docs: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls", fix: "Redirect every http, https, www and apex variant to the one canonical origin with a 301 or 308." },
    check(pages, _group, site) {
        const origins = Object.entries(site?.origins ?? {}).filter(([, facts]) => facts.variants !== undefined);
        if (origins.length === 0) return;
        return origins.flatMap(([subject, facts]): Finding[] => {
            const canonical = canonicalOf(subject, pages);
            const astray = ((facts.variants as { probes: Variant[] }).probes).filter((variant) => variant.resolves && (variant.error !== undefined || new URL(variant.final).origin !== canonical));
            log.debug({ rule: "origin/host-canonical", subject, canonical, astray: astray.length }, "entry variants judged");
            return astray.length === 0 ? [] : [{ rule: "origin/host-canonical", severity, scope: "site", url: subject, message: `entry variants do not land on ${canonical}: ${astray.map((variant) => `${variant.url} → ${variant.error ?? variant.final}`).join("; ")}`, value: astray }];
        });
    },
});

// Where `/` lands in each probed language, and how many distinct URLs that makes.
const locale: SiteExtractor = {
    id: "locale",
    per: "origin",
    async extract(origin, context) {
        const languages: Record<string, string> = {};
        for (const language of LANGUAGES) {
            const answer = await context.fetch(`${origin}/`, { headers: { "accept-language": language }, redirect: "follow" });
            languages[language] = answer.url;
        }
        const distinct = new Set(Object.values(languages)).size;
        log.debug({ origin, distinct }, "locale redirects probed");
        return { languages, distinct };
    },
};

// The size of `/` uncompressed, and which of the codings it is served in when a request accepts only that one.
const encodings: SiteExtractor = {
    id: "encodings",
    per: "origin",
    async extract(origin, context) {
        const url = `${origin}/`;
        const plain = await context.fetch(url, { headers: { "accept-encoding": "identity" }, redirect: "manual" });
        if (plain.status < 200 || plain.status > 299) return { url, status: plain.status };
        const served: string[] = [];
        for (const coding of CODINGS) {
            const answer = await context.fetch(url, { headers: { "accept-encoding": coding }, redirect: "manual" });
            const isServed = String(answer.headers["content-encoding"] ?? "").trim().toLowerCase() === coding;
            log.debug({ url, coding, status: answer.status, isServed }, "encoding probed");
            if (isServed) served.push(coding);
        }
        return { url, status: plain.status, "content-type": mediaType(plain), bytes: Buffer.byteLength(plain.body), served };
    },
};

// A header’s first value, if any.
function first(value: string | string[] | undefined): string | undefined {
    return [value ?? []].flat()[0];
}

// The crawled seed page, else `/` fetched once, asked again with the validator it answered with.
const revalidation: SiteExtractor = {
    id: "revalidation",
    per: "origin",
    async extract(origin, context) {
        const seed = context.pages.find((page) => page.crawl["discovered-via"] === "seed");
        const url = seed?.url.href ?? `${origin}/`;
        const answer = seed ? { status: seed.http.status, headers: seed.http.headers } : await context.fetch(url, { redirect: "manual" });
        const etag = first(answer.headers.etag);
        const modified = first(answer.headers["last-modified"]);
        const condition: Record<string, string> | undefined = etag ? { "if-none-match": etag } : modified ? { "if-modified-since": modified } : undefined;
        log.debug({ url, status: answer.status, etag, modified }, "validator read");
        if (!condition || answer.status < 200 || answer.status > 299) return { url, status: answer.status };
        const repeat = await context.fetch(url, { headers: condition, redirect: "manual" });
        log.debug({ url, condition, status: repeat.status }, "conditional request probed");
        return { url, status: answer.status, validator: etag ? "etag" : "last-modified", repeat: repeat.status };
    },
};

// The answer to `/favicon.ico`.
const favicon: SiteExtractor = {
    id: "favicon",
    per: "origin",
    async extract(origin, context) {
        const answer = await context.fetch(`${origin}/favicon.ico`, { redirect: "follow" });
        return { url: answer.url, status: answer.status, "content-type": mediaType(answer) };
    },
};

// Policy files granting cross-origin reads to Flash and Acrobat, and the pattern of a grant to any origin.
const POLICIES: Record<string, RegExp> = {
    "/crossdomain.xml": /<allow-(?:access|http-request-headers)-from\s[^>]*\bdomain\s*=\s*["']\*["']/i,
    "/clientaccesspolicy.xml": /<domain\s[^>]*\buri\s*=\s*["'](?:https?:\/\/)?\*["']/i,
};

// The policy files that answer 2xx and grant every origin.
const crossDomain: SiteExtractor = {
    id: "cross-domain",
    per: "origin",
    async extract(origin, context) {
        const open: string[] = [];
        for (const [path, grant] of Object.entries(POLICIES)) {
            const answer = await context.fetch(`${origin}${path}`, { redirect: "manual" });
            const isOpen = answer.status >= 200 && answer.status <= 299 && grant.test(answer.body);
            log.debug({ origin, path, status: answer.status, isOpen }, "cross-domain policy probed");
            if (isOpen) open.push(path);
        }
        return { open };
    },
};

// Most `rel=me` profiles one origin’s pages name that are asked to link back.
const REL_ME_MAX = 8;

// A URL without its fragment and trailing slash, so a profile’s link compares with a page.
function bare(href: string): string {
    const url = new URL(href);
    url.hash = "";
    return url.href.replace(/\/$/, "");
}

// Each `rel=me` profile on another origin, and whether its page names one of ours back with `rel=me`.
const meProfiles: SiteExtractor = {
    id: "rel-me",
    per: "origin",
    crawled: true,
    async extract(origin, context) {
        const ours = new Set([`${origin}/`, ...context.pages.map((page) => page.url.href)].map((href) => bare(href)));
        const named = context.pages.flatMap((page) => page.html?.rels.me ?? []).filter((href) => URL.canParse(href) && /^https?:$/.test(new URL(href).protocol) && new URL(href).origin !== origin);
        const targets = [...new Set(named)].slice(0, REL_ME_MAX);
        if (targets.length === 0) return;
        const unverified: string[] = [];
        const unreachable: string[] = [];
        for (const target of targets) {
            try {
                const answer = await context.delegated(target, { redirect: "follow" });
                const $ = load(answer.body);
                const back = $("a[rel][href], link[rel][href]").filter((_, element) => /(?:^|\s)me(?:\s|$)/i.test(String($(element).attr("rel")))).map((_, element) => String($(element).attr("href"))).get();
                const isBack = back.some((href) => URL.canParse(href, answer.url) && ours.has(bare(new URL(href, answer.url).href)));
                log.debug({ origin, target, status: answer.status, links: back.length, isBack }, "rel=me profile probed");
                if (answer.status < 200 || answer.status > 299) unreachable.push(target);
                else if (!isBack) unverified.push(target);
            } catch (error) {
                log.debug({ origin, target, error: reason(error) }, "rel=me profile unreachable");
                unreachable.push(target);
            }
        }
        return { targets, unverified, unreachable };
    },
};

// Checks made once per origin rather than per page.
export default definePlugin({
    name: "origin",
    rules: { "origin/host-canonical": hostCanonical },
    sites: [notFound, entry, variants, locale, encodings, favicon, revalidation, crossDomain, meProfiles],
    presets: {
        origin: {
            description: "Once per origin: missing pages, error pages, entry variants, language redirects, compression, favicon, revalidation, cross-domain policies",
            rules: {
                "origin/soft-404": {
                    fact: "site.origins.*.not-found.status",
                    expect: { enum: [404, 410] },
                    message: "a missing page answers {got}, not 404 or 410",
                    severity: "warning",
                    docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors",
                    fix: "Return 404 or 410 for missing pages instead of 200 with a soft-404 body.",
                },
                "origin/error-page": {
                    fact: "site.origins.*.not-found",
                    expect: { properties: { "content-type": { const: "text/html" }, bytes: { minimum: 1 }, trace: { const: false }, server: { not: { pattern: String.raw`\d+\.\d+` } } } },
                    when: { "site.origins.*.not-found.status": { enum: [404, 410] } },
                    message: "the not-found page is not plain HTML free of stack traces and server versions (got {got})",
                    severity: "warning",
                    docs: "https://owasp.org/www-community/Improper_Error_Handling",
                    fix: "Serve a plain HTML 404 page with no server version or stack trace.",
                },
                "origin/https-entry": {
                    fact: "site.origins.*.entry",
                    expect: { required: ["status", "https"], properties: { status: { enum: [301, 308] }, https: { const: true } } },
                    message: "plain http does not redirect to https in one permanent hop (got {got}); deprecated, see origin/host-canonical",
                    severity: "off",
                    docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Redirections",
                    fix: "Redirect every http request to https with a 301 or 308, preserving the URL.",
                },
                "origin/host-canonical": "warning",
                "origin/entry-hops": {
                    fact: "site.origins.*.variants.long",
                    expect: { maxItems: 0 },
                    message: "entry variants take more than one hop, or two not starting http to https on the same host: {got}",
                    severity: "warning",
                    docs: "https://hstspreload.org/#deployment-recommendations",
                    fix: "Redirect each variant straight to the canonical origin, or first to https on its own host and then there.",
                },
                "origin/entry-permanent": {
                    fact: "site.origins.*.variants.temporary",
                    expect: { maxItems: 0 },
                    message: "entry variants redirect with a temporary status or a meta refresh: {got}",
                    severity: "warning",
                    docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects#permanent-server-side",
                    fix: "Answer every entry variant with 301 or 308, never 302, 307 or a meta refresh.",
                },
                "origin/entry-path": {
                    fact: "site.origins.*.variants.dropped",
                    expect: { maxItems: 0 },
                    message: "entry variants lose the requested path or query on the way: {got}",
                    severity: "warning",
                    docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Redirections",
                    fix: "Carry the request path and query into the Location of every entry redirect.",
                },
                "origin/entry-downgrade": {
                    fact: "site.origins.*.variants.downgraded",
                    expect: { maxItems: 0 },
                    message: "entry variants are sent from https back to plain http: {got}",
                    severity: "error",
                    docs: "https://developer.mozilla.org/docs/Web/Security/Practical_implementation_guides/TLS#http_redirections",
                    fix: "Never redirect an https request to an http URL.",
                },
                "origin/www-resolves": {
                    fact: "site.origins.*.variants.unresolved",
                    expect: { maxItems: 0 },
                    message: "no DNS answer for the entry host {got}; make sure that is deliberate",
                    severity: "hint",
                    docs: "https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes",
                    fix: "Publish an A or AAAA record for the www or apex host and redirect it to the canonical origin.",
                },
                "origin/locale-redirect": {
                    fact: "site.origins.*.locale.distinct",
                    expect: { const: 1 },
                    message: "/ lands on {got} different URLs depending on Accept-Language",
                    severity: "warning",
                    docs: "https://developers.google.com/search/docs/specialty/international/locale-adaptive-pages",
                    fix: "Serve the same content for every language unless the page has language-specific alternates.",
                },
                "origin/compression": {
                    fact: "site.origins.*.encodings.served",
                    expect: { allOf: [{ contains: { const: "br" } }, { contains: { const: "zstd" } }, { contains: { const: "gzip" } }] },
                    when: { "site.origins.*.encodings.bytes": { minimum: 1024 }, "site.origins.*.encodings.content-type": { pattern: String.raw`^(text/|application/xhtml\+xml)` } },
                    message: "/ is served compressed as {got}; offer br, zstd and gzip, each to the clients that ask for it",
                    severity: "info",
                    docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Accept-Encoding",
                    fix: "Configure the server to compress text responses with br, zstd and gzip.",
                },
                "origin/favicon": {
                    fact: "site.origins.*.favicon",
                    expect: { required: ["status", "content-type"], properties: { status: { minimum: 200, maximum: 299 }, "content-type": { pattern: "^image/" } } },
                    message: "/favicon.ico is not an image (got {got})",
                    severity: "info",
                    docs: "https://developers.google.com/search/docs/appearance/favicon-in-search",
                    fix: "Serve /favicon.ico as a real image (PNG, ICO, or SVG).",
                },
                "origin/revalidation": {
                    fact: "site.origins.*.revalidation.repeat",
                    expect: { const: 304 },
                    when: { "site.origins.*.revalidation.validator": { type: "string" } },
                    message: "a conditional request for the seed page answers {got}, not 304 Not Modified",
                    severity: "info",
                    docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Conditional_requests",
                    fix: "Answer a request whose If-None-Match or If-Modified-Since still matches with 304 and no body.",
                },
                "origin/cross-domain-policy": {
                    fact: "site.origins.*.cross-domain.open",
                    expect: { maxItems: 0 },
                    message: "a cross-domain policy file lets any origin read the site as its visitor: {got}",
                    severity: "warning",
                    docs: "https://www.adobe.com/devnet-docs/acrobatetk/tools/AppSec/xdomain.html",
                    fix: "Delete crossdomain.xml and clientaccesspolicy.xml, or list only the domains that need access.",
                },
            },
        },
    },
});
