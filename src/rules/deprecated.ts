// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "./message.ts";
import type { Make } from "./types.ts";

interface Deprecation {
    name: string;
    // What replaces it, or why no browser reads it.
    instead: string;
    // The reference that deprecates it.
    docs: string;
    // Another header that still reads it, so the pair is left alone.
    unless?: string;
}

// Response headers no current browser acts on, by lower-cased name.
export const DEPRECATED: Record<string, Deprecation> = {
    "x-xss-protection": { name: "X-XSS-Protection", instead: "browsers removed the filter; Content-Security-Policy replaces it", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/X-XSS-Protection" },
    "report-to": { name: "Report-To", instead: "Reporting-Endpoints replaces it", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Report-To", unless: "nel" },
    "expect-ct": { name: "Expect-CT", instead: "browsers enforce Certificate Transparency by default", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Expect-CT" },
    "public-key-pins": { name: "Public-Key-Pins", instead: "browsers removed key pinning", docs: "https://chromestatus.com/feature/5903385005916160" },
    "public-key-pins-report-only": { name: "Public-Key-Pins-Report-Only", instead: "browsers removed key pinning", docs: "https://chromestatus.com/feature/5903385005916160" },
    "feature-policy": { name: "Feature-Policy", instead: "Permissions-Policy replaces it", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Permissions-Policy" },
    p3p: { name: "P3P", instead: "W3C retired the standard and no browser reads it", docs: "https://www.w3.org/TR/P3P/" },
};

// One finding per page naming every deprecated header it sends, with what replaces each.
const deprecatedHeader: Make = (severity) => ({
    meta: { id: "http/deprecated-header", severity, scope: "page", facts: ["http.headers"], docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers", fix: "Remove each deprecated header, and send Reporting-Endpoints in place of Report-To unless NEL still reads it." },
    check(page: Facts) {
        const sent = Object.keys(page.http.headers).filter((name) => {
            const entry = DEPRECATED[name];
            return entry !== undefined && (entry.unless === undefined || page.http.headers[entry.unless] === undefined);
        });
        log.debug({ rule: "http/deprecated-header", url: page.url.href, sent }, "deprecated headers checked");
        if (sent.length === 0) return [];
        const listed = sent.map((name) => DEPRECATED[name] as Deprecation);
        return [
            {
                rule: "http/deprecated-header",
                severity,
                scope: "page" as const,
                url: page.url.href,
                group: page.group,
                ...said("the page sends deprecated headers"),
                data: { [page.url.href]: { headers: listed.map((entry) => entry.name).join(", ") } },
                locations: listed.map((entry) => `${entry.name} → ${entry.instead}`),
                value: Object.fromEntries(listed.map((entry) => [entry.name, entry.docs])),
            },
        ];
    },
});

export const deprecatedRules: Record<string, Make> = {
    "http/deprecated-header": deprecatedHeader,
};
