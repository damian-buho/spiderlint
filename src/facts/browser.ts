// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { Page, Request, Response } from "playwright";
import { log } from "../logger.ts";
import { cookieFacts, redirectHop } from "./transport.ts";
import type { BrowserFacts, CookieFacts, HttpFacts, ResourceFacts, TlsFacts } from "./types.ts";

const DAY = 86_400_000;

type Timing = ReturnType<Request["timing"]>;
type Security = NonNullable<Awaited<ReturnType<Response["securityDetails"]>>>;

// Playwright resource types that map onto a resource kind; the main document is never one.
const KINDS: Record<string, ResourceFacts["kind"]> = { script: "script", stylesheet: "style", image: "image", font: "font", document: "iframe", manifest: "manifest" };

// Where the init script keeps each `document.cookie` write for the crawler to read back.
const WRITES = "__spiderlintCookieWrites";

// Wraps the `document.cookie` setter before any page script runs, keeping each write with its value cut out.
export const COOKIE_WRITES = `(() => { const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie"); if (!cookie?.get || !cookie.set) return; const writes = []; Object.defineProperty(globalThis, "${WRITES}", { value: writes }); Object.defineProperty(Document.prototype, "cookie", { configurable: true, enumerable: cookie.enumerable, get: cookie.get, set(value) { writes.push(String(value).replace(/^([^=;]*)=[^;]*/, "$1=")); cookie.set.call(this, value); } }); })();`;

// Cookies the page’s scripts wrote through `document.cookie`, read as Set-Cookie lines, deletions aside; values never leave the page.
export async function scriptCookies(page: Page): Promise<CookieFacts[]> {
    const writes = (await page.evaluate(`globalThis.${WRITES} ?? []`)) as string[];
    const cookies = cookieFacts([...new Set(writes)]).filter((cookie) => (cookie["max-age"] ?? 1) > 0);
    log.debug({ url: page.url(), writes: writes.length, cookies: cookies.length }, "script cookie writes read");
    return cookies;
}

// Header pairs as the facts document holds them: lower-cased names, repeated ones as arrays.
export function headerFacts(pairs: { name: string; value: string }[]): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const { name, value } of pairs) {
        const key = name.toLowerCase();
        const had = out[key];
        out[key] = had === undefined ? value : [had, value].flat();
    }
    return out;
}

// Milliseconds between two Resource Timing marks, absent when either was not reached.
function span(from: number, to: number): number | undefined {
    return from >= 0 && to >= from ? Math.round(to - from) : undefined;
}

// Chromium’s Resource Timing marks renamed to the phases got reports.
export function timingFacts(timing: Timing): HttpFacts["timing"] {
    const isSecure = timing.secureConnectionStart >= 0;
    const phases: HttpFacts["timing"] = {
        dns: span(timing.domainLookupStart, timing.domainLookupEnd),
        tcp: span(timing.connectStart, isSecure ? timing.secureConnectionStart : timing.connectEnd),
        tls: isSecure ? span(timing.secureConnectionStart, timing.connectEnd) : undefined,
        ttfb: span(timing.requestStart, timing.responseStart),
        download: span(timing.responseStart, timing.responseEnd),
        total: span(0, timing.responseEnd),
    };
    return Object.fromEntries(Object.entries(phases).filter(([, value]) => value !== undefined));
}

// Every URL the navigation passed through after the first, with the status and headers of the response that sent it there.
export async function redirectFacts(request: Request): Promise<HttpFacts["redirects"]> {
    const hops: HttpFacts["redirects"] = [];
    for (let hop = request, from = hop.redirectedFrom(); from; hop = from, from = from.redirectedFrom()) {
        const response = await from.response();
        const headers = response ? headerFacts(await response.headersArray()) : undefined;
        hops.unshift(response && headers ? redirectHop(hop.url(), response.status(), headers) : { url: hop.url() });
    }
    return hops;
}

// The address Chromium connected to, with the family Node’s sockets report.
export function remoteFacts(address: { ipAddress: string } | null): HttpFacts["remote"] {
    if (!address) return undefined;
    const ip = address.ipAddress.replaceAll(/^\[|\]$/g, "");
    const version = isIP(ip);
    return { address: ip, ...(version > 0 && { family: `IPv${version}` }) };
}

// Chromium’s `TLS 1.3` spelled as Node’s `TLSv1.3`; QUIC always runs TLS 1.3 (RFC 9001 §4.2).
function protocolName(protocol: string): string {
    return protocol === "QUIC" ? "TLSv1.3" : protocol.replace(/^TLS (\d\.\d)$/, "TLSv$1");
}

// A navigation Chromium completed was authorized; cipher, ALPN and fingerprint stay absent, the protocol does not say them.
export function tlsFacts(details: Security | null, now = Date.now()): TlsFacts | undefined {
    if (!details?.protocol) return undefined;
    const notBefore = details.validFrom === undefined ? undefined : new Date(details.validFrom * 1000).toISOString();
    const notAfter = details.validTo === undefined ? undefined : new Date(details.validTo * 1000).toISOString();
    return {
        protocol: protocolName(details.protocol),
        authorized: true,
        cert: {
            ...(details.subjectName && { subject: details.subjectName }),
            ...(details.issuer && { issuer: details.issuer }),
            ...(notBefore && { "not-before": notBefore }),
            ...(notAfter && { "not-after": notAfter, "days-left": Math.floor((Date.parse(notAfter) - now) / DAY) }),
            san: [],
        },
    };
}

// What the network log adds to the static census: observed entries flagged, runtime-only ones appended, at most `max`.
export function observedResources(declared: ResourceFacts[], requests: Request[], page: URL, max: number): ResourceFacts[] {
    const found = new Map(declared.map((resource) => [`${resource.kind} ${resource.url}`, resource]));
    for (const request of requests) {
        const kind = KINDS[request.resourceType()];
        const isMainFrame = request.frame().parentFrame() === null;
        if (!kind || (kind === "iframe" && isMainFrame) || !URL.canParse(request.url())) continue;
        const url = new URL(request.url());
        url.hash = "";
        if (!/^https?:$/.test(url.protocol)) continue;
        const key = `${kind} ${url.href}`;
        const known = found.get(key);
        found.set(key, { ...(known ?? { url: url.href, kind, origin: url.origin === page.origin ? "same" : "cross" }), observed: true });
    }
    return found.values().take(max).toArray();
}

// Body bytes on the wire; Chromium’s size goes negative on some responses, where Content-Length stands in, else `fallback`.
export async function wireSize(request: Request, fallback = 0): Promise<number> {
    const { responseBodySize } = await request.sizes();
    if (responseBodySize >= 0) return responseBodySize;
    const response = await request.response();
    const declared = Number((await response?.headerValue("content-length")) ?? NaN);
    log.debug({ url: request.url(), responseBodySize, declared, fallback }, "wire size unknown, using Content-Length or fallback");
    return Number.isSafeInteger(declared) ? declared : fallback;
}

// Bytes the network log received per resource kind, keyed as `browser.weight` names them; failed requests weigh nothing.
export async function weightFacts(requests: Request[]): Promise<BrowserFacts["weight"]> {
    const weight: BrowserFacts["weight"] = {};
    for (const request of requests) {
        const kind = KINDS[request.resourceType()];
        if (request.failure() || (kind !== "script" && kind !== "style" && kind !== "image" && kind !== "font")) continue;
        weight[kind] = (weight[kind] ?? 0) + (await wireSize(request));
    }
    return weight;
}

// HTTP version per protocol Chromium’s network log names.
const HOP_VERSIONS: Record<string, string> = { h3: "3.0", h2: "2.0", "http/1.1": "1.1" };

// Chromium’s TLS completed by the probe when both saw one certificate, and the HTTP version: the measured hop, else QUIC is 3, the probe’s ALPN, plain text 1.1.
export function withProbe(url: string, seen: TlsFacts | undefined, security: string | undefined, probed: TlsFacts | undefined, hop?: string): { tls?: TlsFacts; version?: string } {
    if (security === undefined) return { ...(seen && { tls: seen }), version: HOP_VERSIONS[hop ?? ""] ?? "1.1" };
    const isSame = probed !== undefined && (seen === undefined || (seen.cert.subject === probed.cert.subject && seen.cert["not-after"] === probed.cert["not-after"]));
    log.debug({ url, security, hop, isProbed: probed !== undefined, isSame, subject: seen?.cert.subject, probedSubject: probed?.cert.subject }, "probed TLS compared");
    const tls = isSame ? { ...probed, ...(seen?.protocol && { protocol: seen.protocol }) } : seen;
    const version = HOP_VERSIONS[hop ?? ""] ?? (security === "QUIC" ? "3.0" : isSame ? (probed.alpn === "h2" ? "2.0" : "1.1") : undefined);
    return { ...(tls && { tls }), ...(version && { version }) };
}
