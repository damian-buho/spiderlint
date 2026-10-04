// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { getDomain } from "tldts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "./types.ts";

// How a disclosing field is judged: `version` warns on a version number, `always` warns, `presence` only hints.
type Kind = "version" | "always" | "presence";

// Response headers, and the generator meta, that name the software behind a response.
export const DISCLOSING: Record<string, Kind> = {
    server: "version",
    via: "version",
    "x-generator": "version",
    "meta generator": "version",
    "x-powered-by": "always",
    "x-aspnet-version": "always",
    "x-aspnetmvc-version": "always",
    "x-debug-token": "always",
    "x-debug-token-link": "always",
    "x-drupal-cache": "presence",
    "x-varnish": "presence",
    "x-runtime": "presence",
};

// Products a CDN or hosting platform names in `Server` and the owner cannot remove.
export const UNREMOVABLE = new Set(["cloudflare", "amazons3", "cloudfront", "fastly", "akamaighost", "akamainetstorage", "netlify", "vercel", "github.com", "gws", "esf", "sffe", "google frontend", "bunnycdn", "keycdn"]);

// A version number: a digit after `/`, a space or `(`, optionally `v`-prefixed.
const VERSION = /(?:^|[/\s(])v?\d/i;

// A value with `Via`’s received-protocol dropped, since `1.1` there is HTTP’s version, not the proxy’s.
function stripped(field: string, value: string): string {
    return field === "via" ? value.split(",").map((hop) => hop.trim().replace(/^\S+\s+/, "")).join(", ") : value.trim();
}

// The severity one field earns, or undefined when it discloses nothing the owner can change.
function judge(field: string, value: string, severity: Finding["severity"]): Finding["severity"] | undefined {
    const product = stripped(field, value);
    const kind = DISCLOSING[field] ?? "presence";
    const isVersioned = VERSION.test(product);
    const isUnremovable = field === "server" && UNREMOVABLE.has(product.toLowerCase().split("/", 1)[0] ?? "");
    log.debug({ rule: "http/server-disclosure", field, value, kind, isVersioned, isUnremovable }, "disclosure judged");
    if (isUnremovable || product.length === 0) return undefined;
    return kind === "always" || (isVersioned && kind === "version") ? severity : "hint";
}

// Each disclosing field of one response, joined when repeated.
function fields(headers: Record<string, string | string[]> | undefined, generator?: string): [string, string][] {
    const found = Object.keys(DISCLOSING).flatMap((name): [string, string][] => {
        const value = [headers?.[name] ?? []].flat().join(", ");
        return value ? [[name, value]] : [];
    });
    return generator ? [...found, ["meta generator", generator]] : found;
}

// The registrable domain of a host, the host itself when it has none.
function domainOf(host: string): string {
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

// One finding per host, field and value across every page and every resource under a crawled registrable domain.
const serverDisclosure: Make = (severity) => ({
    meta: { id: "http/server-disclosure", severity, scope: "site", facts: ["http.headers", "html.meta.generator", "resources"], docs: "https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Server", fix: "Remove the version from the Server header and drop X-Powered-By and debug headers at the server or proxy." },
    check(pages: Facts[]) {
        const domains = new Set(pages.map((page) => domainOf(page.url.host)));
        const seen = new Map<string, { host: string; field: string; value: string; urls: Set<string> }>();
        const note = (url: string, found: [string, string][]) => {
            const host = new URL(url).host;
            for (const [field, value] of found) {
                const key = `${host}\n${field}\n${value}`;
                const entry = seen.get(key) ?? { host, field, value, urls: new Set<string>() };
                entry.urls.add(url);
                seen.set(key, entry);
            }
        };
        for (const page of pages) {
            note(page.url.href, fields(page.http.headers, page.html?.meta.generator));
            const owned = (page.resources ?? []).filter((resource) => domains.has(domainOf(new URL(resource.url).host)));
            for (const resource of owned) note(resource.url, fields(resource.http?.headers));
        }
        const findings: Finding[] = [];
        for (const { host, field, value, urls } of seen.values()) {
            const level = judge(field, value, severity);
            if (!level) continue;
            const listed = [...urls].toSorted((a, b) => a.localeCompare(b));
            findings.push({ rule: "http/server-disclosure", severity: level, scope: "site", url: listed[0] as string, message: `${host} names its software in ${field}: ${value} (${listed.length} responses)`, value: { [field]: value }, urls: listed, score: level === "hint" ? 3.5 : 5.4 });
        }
        return findings;
    },
});

export const disclosureRules: Record<string, Make> = {
    "http/server-disclosure": serverDisclosure,
};
