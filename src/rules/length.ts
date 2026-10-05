// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { MISMATCH } from "../crawl/fetch.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "./types.ts";

// What is wrong with a response’s framing headers, or undefined when nothing is.
export function framingFault(status: number, headers: Record<string, string | string[]>, error?: string): string | undefined {
    const hasLength = headers["content-length"] !== undefined;
    const detail = error?.startsWith(MISMATCH) ? error.slice(MISMATCH.length + 2) : undefined;
    if (detail !== undefined) return detail ? `its ${detail}` : "its body does not match Content-Length, or Content-Length is sent twice or beside chunked";
    if (hasLength && headers["transfer-encoding"] !== undefined) return "it sends Content-Length beside Transfer-Encoding";
    return hasLength && status === 204 ? "a 204 carries Content-Length" : undefined;
}

// One finding per host whose pages, and per resource whose response, frame the body wrongly.
const contentLength: Make = (severity) => ({
    meta: { id: "http/content-length", severity, scope: "site", facts: ["http.headers", "resources"], docs: "https://www.rfc-editor.org/rfc/rfc9112#section-6.3", fix: "Send one Content-Length equal to the body, none beside Transfer-Encoding and none on a 204." },
    check(pages: Facts[]) {
        const byFault = new Map<string, { message: string; urls: Set<string> }>();
        const note = (key: string, message: string, url: string) => byFault.set(key, { message, urls: (byFault.get(key)?.urls ?? new Set()).add(url) });
        for (const page of pages) {
            const fault = framingFault(page.http.status, page.http.headers, page.http.error);
            log.debug({ rule: "http/content-length", url: page.url.href, fault }, "page framing judged");
            if (fault) note(`${page.url.host}\t${fault}`, `${page.url.host}: ${fault}`, page.url.href);
            const resources = page.resources ?? [];
            for (const resource of resources) {
                const http = resource.http;
                const found = http && framingFault(http.status, http.headers, http.error);
                if (found) note(resource.url, `${resource.kind} ${found}`, page.url.href);
            }
        }
        const findings: Finding[] = [];
        for (const [key, { message, urls }] of byFault) {
            const listed = [...urls].toSorted((a, b) => a.localeCompare(b));
            const isResource = !key.includes("\t");
            findings.push({ rule: "http/content-length", severity, scope: "site", url: isResource ? key : (listed[0] as string), message: `${message}; ${isResource ? "used by" : "on"} ${listed.length} pages`, urls: listed });
        }
        return findings;
    },
});

export const lengthRules: Record<string, Make> = {
    "http/content-length": contentLength,
};
