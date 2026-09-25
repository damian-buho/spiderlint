// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { Request, Response } from "playwright";
import { log } from "../logger.ts";
import type { BrowserFacts, HttpFacts, ResourceFacts, TlsFacts } from "./types.ts";

const DAY = 86_400_000;

type Timing = ReturnType<Request["timing"]>;
type Security = NonNullable<Awaited<ReturnType<Response["securityDetails"]>>>;

// Playwright resource types that map onto a resource kind; the main document is never one.
const KINDS: Record<string, ResourceFacts["kind"]> = { script: "script", stylesheet: "style", image: "image", font: "font", document: "iframe", manifest: "manifest" };

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

// Every URL the navigation passed through after the first, as got’s `redirectUrls` lists them.
export function redirectFacts(request: Request): HttpFacts["redirects"] {
    const chain: string[] = [];
    for (let hop: Request | null = request; hop; hop = hop.redirectedFrom()) chain.unshift(hop.url());
    return chain.slice(1).map((url) => ({ url }));
}

// The address Chromium connected to, with the family Node’s sockets report.
export function remoteFacts(address: { ipAddress: string } | null): HttpFacts["remote"] {
    if (!address) return undefined;
    const version = isIP(address.ipAddress);
    return { address: address.ipAddress, ...(version > 0 && { family: `IPv${version}` }) };
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
            ...(notBefore && { notBefore }),
            ...(notAfter && { notAfter, daysLeft: Math.floor((Date.parse(notAfter) - now) / DAY) }),
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
