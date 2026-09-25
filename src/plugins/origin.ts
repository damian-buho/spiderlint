// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { reason } from "../crawl/fetch.ts";
import type { Probe } from "../crawl/probe.ts";
import { log } from "../logger.ts";
import { definePlugin, type SiteExtractor } from "./types.ts";

// Stack trace shapes of the common server runtimes.
const TRACE = /Traceback \(most recent call last\)|^\s+at \S.*:\d+:\d+\)?$|Stack trace:|Exception in thread|Fatal error: .* on line \d+/m;

// Languages `/` is fetched in; spread across scripts and directions so one special-cased locale shows.
const LANGUAGES = ["en", "uk", "ja", "ar"];

// A response’s media type without parameters.
function mediaType(answer: Probe): string {
    return String(answer.headers["content-type"] ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

// The answer to a random path, logged so an owner can find it in their access log.
const notFound: SiteExtractor = {
    id: "notFound",
    per: "origin",
    async extract(origin, context) {
        const url = `${origin}/spiderlint-${randomUUID()}`;
        log.info({ url }, "missing page probed");
        const answer = await context.fetch(url, { redirect: "manual" });
        const server = answer.headers.server;
        const location = answer.headers.location;
        return { url, status: answer.status, contentType: mediaType(answer), bytes: Buffer.byteLength(answer.body), trace: TRACE.test(answer.body), ...(typeof server === "string" && { server }), ...(typeof location === "string" && { location }) };
    },
};

// The first answer of plain http on the origin’s host, and whether it redirects to `https://<host>/`; an onion service is skipped.
const entry: SiteExtractor = {
    id: "entry",
    per: "origin",
    async extract(origin, context) {
        const { protocol, hostname, host } = new URL(origin);
        if (hostname.endsWith(".onion")) return;
        const url = `http://${protocol === "http:" ? host : hostname}/`;
        try {
            const answer = await context.fetch(url, { redirect: "manual" });
            const location = answer.headers.location;
            const target = typeof location === "string" && URL.canParse(location, url) ? new URL(location, url).href : undefined;
            log.debug({ url, status: answer.status, target }, "plain http entry probed");
            return { url, status: answer.status, https: target === `https://${hostname}/`, ...(target && { location: target }) };
        } catch (error) {
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

// The answer to `/favicon.ico`.
const favicon: SiteExtractor = {
    id: "favicon",
    per: "origin",
    async extract(origin, context) {
        const answer = await context.fetch(`${origin}/favicon.ico`, { redirect: "follow" });
        return { url: answer.url, status: answer.status, contentType: mediaType(answer) };
    },
};

// Checks made once per origin rather than per page.
export default definePlugin({
    name: "origin",
    sites: [notFound, entry, locale, favicon],
    presets: {
        origin: {
            description: "Once per origin: missing pages, error pages, plain http entry, language redirects, favicon",
            rules: {
                "origin/soft-404": {
                    fact: "site.origins.*.notFound.status",
                    expect: { enum: [404, 410] },
                    message: "a missing page answers {got}, not 404 or 410",
                    severity: "warning",
                    docs: "https://developers.google.com/search/docs/crawling-indexing/http-network-errors#soft-404-errors",
                },
                "origin/error-page": {
                    fact: "site.origins.*.notFound",
                    expect: { properties: { contentType: { const: "text/html" }, bytes: { minimum: 1 }, trace: { const: false }, server: { not: { pattern: String.raw`\d+\.\d+` } } } },
                    when: { "site.origins.*.notFound.status": { enum: [404, 410] } },
                    message: "the not-found page is not plain HTML free of stack traces and server versions (got {got})",
                    severity: "warning",
                },
                "origin/https-entry": {
                    fact: "site.origins.*.entry",
                    expect: { required: ["status", "https"], properties: { status: { enum: [301, 308] }, https: { const: true } } },
                    message: "plain http does not redirect to https in one permanent hop (got {got})",
                    severity: "warning",
                },
                "origin/locale-redirect": {
                    fact: "site.origins.*.locale.distinct",
                    expect: { const: 1 },
                    message: "/ lands on {got} different URLs depending on Accept-Language",
                    severity: "warning",
                    docs: "https://developers.google.com/search/docs/specialty/international/locale-adaptive-pages",
                },
                "origin/favicon": {
                    fact: "site.origins.*.favicon",
                    expect: { required: ["status", "contentType"], properties: { status: { minimum: 200, maximum: 299 }, contentType: { pattern: "^image/" } } },
                    message: "/favicon.ico is not an image (got {got})",
                    severity: "info",
                    docs: "https://developers.google.com/search/docs/appearance/favicon-in-search",
                },
            },
        },
    },
});
