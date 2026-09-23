// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, HtmlFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Rule, Severity } from "./types.ts";

type Make = (severity: Exclude<Severity, "off">) => Rule;

// Every in-scope page answering 4xx or 5xx, with the pages that link to it.
const brokenInternal: Make = (severity) => ({
    meta: { id: "links/broken-internal", severity, scope: "site", facts: ["http.status", "crawl.referrers"] },
    check(pages: Facts[]) {
        const findings: Finding[] = [];
        for (const page of pages) {
            if (page.http.status < 400) continue;
            log.debug({ url: page.url.href, status: page.http.status, referrers: page.crawl.referrers.length }, "broken link");
            findings.push({ rule: "links/broken-internal", severity, scope: "site", url: page.url.href, message: `http.status is ${page.http.status}; linked from ${page.crawl.referrers.length} pages`, value: page.http.status, urls: page.crawl.referrers });
        }
        return findings;
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
        return isDenied ? [] : [{ rule: "http/frame-options", severity, scope: "page", url: page.url.href, group: page.group, message: `neither content-security-policy frame-ancestors nor x-frame-options refuses framing (x-frame-options: ${options || "absent"})`, value: options || undefined }];
    },
});

// Fragment-free absolute form of a URL relative to the page; an unparsable value stays as written.
function resolve(raw: string, base: string): string {
    if (!URL.canParse(raw, base)) return raw;
    const url = new URL(raw, base);
    url.hash = "";
    return url.href;
}

// A page whose `fact` names a URL other than its own; a page without the fact is skipped.
function pointsHere(id: string, fact: string, read: (html: HtmlFacts) => string | undefined): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts: [fact] },
        check(page: Facts) {
            const raw = page.html && read(page.html);
            if (raw === undefined) return;
            const target = resolve(raw, page.url.href);
            const here = resolve(page.url.href, page.url.href);
            log.debug({ rule: id, url: page.url.href, target, matches: target === here }, "self reference checked");
            return target === here ? [] : [{ rule: id, severity, scope: "page", url: page.url.href, group: page.group, message: `${fact} names ${target}, not this page`, value: raw }];
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

// TypeScript rules a preset enables by ID alone.
export const builtin: Record<string, Make> = {
    "links/broken-internal": brokenInternal,
    "http/frame-options": frameOptions,
    "http/consistent-origin": consistentOrigin,
    "html/canonical-self": pointsHere("html/canonical-self", "html.canonical", (html) => html.canonical),
    "html/og-url-self": pointsHere("html/og-url-self", "html.property.og:url", (html) => html.property["og:url"]),
};
