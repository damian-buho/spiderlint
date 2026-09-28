// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { reason } from "../crawl/fetch.ts";
import { RobotsDisallowed, type Probe } from "../crawl/probe.ts";
import { log } from "../logger.ts";
import { definePlugin, type SiteExtractor } from "./types.ts";

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

// Checks made once per origin rather than per page.
export default definePlugin({
    name: "origin",
    sites: [notFound, entry, locale, encodings, favicon, revalidation],
    presets: {
        origin: {
            description: "Once per origin: missing pages, error pages, plain http entry, language redirects, compression, favicon, revalidation",
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
                    message: "plain http does not redirect to https in one permanent hop (got {got})",
                    severity: "warning",
                    docs: "https://developer.mozilla.org/docs/Web/HTTP/Guides/Redirections",
                    fix: "Redirect every http request to https with a 301 or 308, preserving the URL.",
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
            },
        },
    },
});
