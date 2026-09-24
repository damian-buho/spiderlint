// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { Request, Response } from "playwright";
import type { BrowserFacts, HttpFacts, ResourceFacts, TlsFacts } from "./types.ts";

const DAY = 86_400_000;

type Timing = ReturnType<Request["timing"]>;
type Security = NonNullable<Awaited<ReturnType<Response["securityDetails"]>>>;

// Playwright resource types that map onto a resource kind; the main document is never one.
const KINDS: Record<string, ResourceFacts["kind"]> = { script: "script", stylesheet: "style", image: "image", font: "font", document: "iframe" };

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

// A navigation Chromium completed was authorized; cipher, ALPN and fingerprint stay absent, the protocol does not say them.
export function tlsFacts(details: Security | null, now = Date.now()): TlsFacts | undefined {
    if (!details?.protocol) return undefined;
    const notBefore = details.validFrom === undefined ? undefined : new Date(details.validFrom * 1000).toISOString();
    const notAfter = details.validTo === undefined ? undefined : new Date(details.validTo * 1000).toISOString();
    return {
        protocol: details.protocol,
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

// Bytes the network log received per resource kind, keyed as `browser.weight` names them; failed requests weigh nothing.
export async function weightFacts(requests: Request[]): Promise<BrowserFacts["weight"]> {
    const weight: BrowserFacts["weight"] = {};
    for (const request of requests) {
        const kind = KINDS[request.resourceType()];
        if (request.failure() || (kind !== "script" && kind !== "style" && kind !== "image" && kind !== "font")) continue;
        const { responseBodySize } = await request.sizes();
        weight[kind] = (weight[kind] ?? 0) + responseBodySize;
    }
    return weight;
}
