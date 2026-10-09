// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { MISMATCH } from "../crawl/fetch.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "./message.ts";
import type { Finding, Make } from "./types.ts";

// What is wrong with a response’s framing: the fault’s sentence and the detail measured, or undefined when nothing is.
interface Fault {
    text: string;
    detail?: string;
}

// What a resource finding names first.
const SUBJECT = "{kind}:";

// What is wrong with a response’s framing headers, or undefined when nothing is.
export function framingFault(status: number, headers: Record<string, string | string[]>, error?: string): Fault | undefined {
    const hasLength = headers["content-length"] !== undefined;
    const detail = error?.startsWith(MISMATCH) ? error.slice(MISMATCH.length + 2) : undefined;
    if (detail) return { text: "the response body ended short of the bytes Content-Length declares", detail };
    if (detail !== undefined) return { text: "the response body does not match Content-Length, or Content-Length is sent twice or beside chunked" };
    if (hasLength && headers["transfer-encoding"] !== undefined) return { text: "the response sends Content-Length beside Transfer-Encoding" };
    return hasLength && status === 204 ? { text: "a 204 response carries Content-Length" } : undefined;
}

// One finding per host whose pages, and per resource whose response, frame the body wrongly.
const contentLength: Make = (severity) => ({
    meta: { id: "http/content-length", severity, scope: "site", facts: ["http.headers", "resources"], docs: "https://www.rfc-editor.org/rfc/rfc9112#section-6.3", fix: "Send one Content-Length equal to the body, none beside Transfer-Encoding and none on a 204." },
    check(pages: Facts[]) {
        const byFault = new Map<string, { subject: string; kind?: string; fault: Fault; urls: Set<string> }>();
        const note = (key: string, subject: string, fault: Fault, url: string, kind?: string) => byFault.set(key, { subject, ...(kind && { kind }), fault, urls: (byFault.get(key)?.urls ?? new Set()).add(url) });
        for (const page of pages) {
            const fault = framingFault(page.http.status, page.http.headers, page.http.error);
            log.debug({ rule: "http/content-length", url: page.url.href, fault }, "page framing judged");
            if (fault) note(`${page.url.host}\t${fault.text}\t${fault.detail}`, page.url.host, fault, page.url.href);
            const resources = page.resources ?? [];
            for (const resource of resources) {
                const http = resource.http;
                const found = http && framingFault(http.status, http.headers, http.error);
                if (found) note(resource.url, resource.url, found, page.url.href, resource.kind);
            }
        }
        const findings: Finding[] = [];
        for (const [key, { subject, kind, fault, urls }] of byFault) {
            const listed = [...urls].toSorted((a, b) => a.localeCompare(b));
            const sentence = kind === undefined ? said(`${fault.text}; on these pages`) : said(`${SUBJECT} ${fault.text}; used by these pages`, { kind });
            log.debug({ rule: "http/content-length", subject, key, pages: listed.length }, "framing fault grouped");
            findings.push({ rule: "http/content-length", severity, scope: "site", url: subject, ...sentence, ...(fault.detail && { data: { [subject]: { detail: fault.detail } } }), urls: listed });
        }
        return findings;
    },
});

export const lengthRules: Record<string, Make> = {
    "http/content-length": contentLength,
};
