// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, HtmlFacts, ResourceFacts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make, Severity } from "./types.ts";

// Every in-scope page answering 4xx or 5xx, with the pages that link to it.
const brokenInternal: Make = (severity) => ({
    meta: { id: "links/broken-internal", severity, scope: "site", facts: ["http.status", "crawl.referrers"] },
    check(pages: Facts[]) {
        const findings: Finding[] = [];
        for (const page of pages) {
            if (page.http.status < 400) continue;
            log.debug({ url: page.url.href, status: page.http.status, referrers: page.crawl.referrers.length }, "broken link");
            findings.push({ rule: "links/broken-internal", severity, scope: "site", url: page.url.href, message: `http.status is ${page.http.status}; linked from ${pageCount(page.crawl.referrers.length)}`, value: page.http.status, urls: page.crawl.referrers });
        }
        return findings;
    },
});

// A page count with its noun.
function pageCount(count: number): string {
    return `${count} page${count === 1 ? "" : "s"}`;
}

// Every internal link answering with a redirect, once per target, with the pages linking to it.
const redirectedInternal: Make = (severity) => ({
    meta: { id: "links/redirected-internal", severity, scope: "site", facts: ["site.redirects", "html.links.internal"], docs: "https://developers.google.com/search/docs/crawling-indexing/301-redirects" },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const landing = new Map(Object.entries(site?.redirects ?? {}));
        const linking = new Map<string, string[]>();
        for (const page of pages) {
            const hrefs = new Set(page.html?.links.internal);
            for (const href of hrefs) if (landing.has(href)) linking.set(href, [...(linking.get(href) ?? []), page.url.href]);
        }
        log.debug({ rule: "links/redirected-internal", redirecting: landing.size, linked: linking.size }, "internal redirects judged");
        return linking.entries().map(([href, urls]) => ({ rule: "links/redirected-internal", severity, scope: "site" as const, url: href, message: `redirects to ${landing.get(href)}; linked from ${pageCount(urls.length)}`, value: landing.get(href), urls })).toArray();
    },
});

// Every sitemap file that failed to fetch, failed to parse, or named no URL.
const sitemapUnreadable: Make = (severity) => ({
    meta: { id: "sitemap/unreadable", severity, scope: "site", facts: ["site.sitemaps"], docs: "https://www.sitemaps.org/protocol.html" },
    check(_pages: Facts[], _group?: string, site?: SiteFacts) {
        const files = site?.sitemaps ?? [];
        log.debug({ rule: "sitemap/unreadable", files: files.length }, "sitemap files judged");
        return files.filter((file) => file.error).map((file) => ({ rule: "sitemap/unreadable", severity, scope: "site" as const, url: file.url, message: `sitemap ${file.error}`, value: file.status }));
    },
});

// A header's value, repeated fields joined; absent is empty.
function header(page: Facts, name: string): string {
    const value = page.http.headers[name] ?? "";
    return Array.isArray(value) ? value.join(", ") : value;
}

// Framing refused by CSP `frame-ancestors` or by `X-Frame-Options` DENY or SAMEORIGIN.
const frameOptions: Make = (severity) => ({
    meta: { id: "http/frame-options", severity, scope: "page", facts: ["http.headers.content-security-policy", "http.headers.x-frame-options"], docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors" },
    check(page: Facts) {
        const hasAncestors = /(?:^|[;,])\s*frame-ancestors\s/i.test(header(page, "content-security-policy"));
        const options = header(page, "x-frame-options").trim();
        const isDenied = hasAncestors || /^(?:deny|sameorigin)$/i.test(options);
        log.debug({ rule: "http/frame-options", url: page.url.href, hasAncestors, options, isDenied }, "framing checked");
        return isDenied ? [] : [{ rule: "http/frame-options", severity, scope: "page" as const, url: page.url.href, group: page.group, message: `neither content-security-policy frame-ancestors nor x-frame-options refuses framing (x-frame-options: ${options || "absent"})`, value: options || undefined }];
    },
});

// Fragment-free absolute form of a URL relative to the page; an unparsable value stays as written.
function resolve(raw: string, base: string): string {
    if (!URL.canParse(raw, base)) return raw;
    const url = new URL(raw, base);
    url.hash = "";
    return url.href;
}

// A page whose `fact` names a URL other than its own or its twin on the canonical origin; a page without the fact is skipped.
function pointsHere(id: string, fact: string, read: (html: HtmlFacts) => string | undefined): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts: [fact] },
        check(page: Facts) {
            const raw = page.html && read(page.html);
            if (raw === undefined) return;
            const target = resolve(raw, page.url.href);
            const here = [page.url.href, page.url.twin].flatMap((href) => (href ? [resolve(href, href)] : []));
            const matches = here.includes(target);
            log.debug({ rule: id, url: page.url.href, twin: page.url.twin, target, matches }, "self reference checked");
            return matches ? [] : [{ rule: id, severity, scope: "page" as const, url: page.url.href, group: page.group, message: `${fact} names ${target}, not this page`, value: raw }];
        },
    });
}

// Per-connection facts that should not differ between pages of one host.
const ORIGIN: [string, (page: Facts) => string | undefined][] = [
    ["tls.cert.fingerprint256", (page) => page.tls?.cert.fingerprint256],
    ["tls.protocol", (page) => page.tls?.protocol],
    ["http.remote.address", (page) => page.http.remote?.address],
    ["http.headers.server", (page) => header(page, "server") || undefined],
];

// The finding for one host and fact when its value varies across the host's pages.
function varies(severity: Exclude<Severity, "off">, host: string, members: Facts[], fact: string, read: (page: Facts) => string | undefined): Finding | undefined {
    const byValue = Map.groupBy(
        members.filter((page) => read(page) !== undefined),
        (page) => read(page) as string,
    );
    log.debug({ rule: "http/consistent-origin", host, fact, values: byValue.size }, "origin fact compared");
    if (byValue.size < 2) return undefined;
    const entries = byValue.entries().toArray();
    const urls = entries.flatMap(([, group]) => group.map((page) => page.url.href));
    const message = `${fact} varies across ${host}: ${entries.map(([value, group]) => `${value} (${group.length})`).join(", ")}`;
    return { rule: "http/consistent-origin", severity, scope: "site", url: urls[0] as string, message, value: Object.fromEntries(entries.map(([value, group]) => [value, group.length])), urls };
}

// One finding per host and fact whose value varies across its pages, with the URL count per value.
const consistentOrigin: Make = (severity) => ({
    meta: { id: "http/consistent-origin", severity, scope: "site", facts: ORIGIN.map(([fact]) => fact) },
    check(pages: Facts[]) {
        const hosts = Map.groupBy(pages, (page) => page.url.host).entries().toArray();
        return hosts.flatMap(([host, members]) => ORIGIN.map(([fact, read]) => varies(severity, host, members, fact, read)).filter((finding) => finding !== undefined));
    },
});

type Verdict = (resource: ResourceFacts, pages: number) => string | undefined;

// A site rule keyed by resource URL: one finding per offending resource, its pages as `urls`.
function resourceRule(id: string, isUsed: (page: Facts, resource: ResourceFacts) => boolean, verdict: Verdict): Make {
    return (severity) => ({
        meta: { id, severity, scope: "site", facts: ["resources"] },
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
                const message = verdict(resource, urls.length);
                log.debug({ rule: id, resource: url, pages: urls.length, isFinding: message !== undefined }, "resource judged");
                if (message) findings.push({ rule: id, severity, scope: "site", url, message, value: resource.http?.status, urls });
            }
            return findings;
        },
    });
}

const isAnyUse = () => true;

// A fetched resource answering outside 2xx, or not at all.
const resourceStatus: Verdict = (resource, pages) => {
    const http = resource.http;
    if (!http || (http.status >= 200 && http.status < 300)) return;
    return http.status === 0 ? `${resource.kind} could not be fetched (${http.error}); used by ${pages} pages` : `${resource.kind} answers ${http.status}; used by ${pages} pages`;
};

// TypeScript rules a preset enables by ID alone.
export const builtin: Record<string, Make> = {
    "links/broken-internal": brokenInternal,
    "links/redirected-internal": redirectedInternal,
    "http/frame-options": frameOptions,
    "http/consistent-origin": consistentOrigin,
    "sitemap/unreadable": sitemapUnreadable,
    "resources/status": resourceRule("resources/status", isAnyUse, resourceStatus),
    "resources/mixed-content": resourceRule(
        "resources/mixed-content",
        (page, resource) => page.url.protocol === "https:" && resource.url.startsWith("http:"),
        (resource, pages) => `${resource.kind} loads over http: on ${pages} https: pages`,
    ),
    "resources/sri": resourceRule(
        "resources/sri",
        (_page, resource) => resource.origin === "cross" && (resource.kind === "script" || resource.kind === "style"),
        (resource, pages) => (resource.integrity ? undefined : `cross-origin ${resource.kind} without integrity; used by ${pages} pages`),
    ),
    "html/canonical-self": pointsHere("html/canonical-self", "html.canonical", (html) => html.canonical),
    "html/og-url-self": pointsHere("html/og-url-self", "html.property.og:url", (html) => html.property["og:url"]),
};
