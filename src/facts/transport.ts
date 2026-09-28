// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { X509Certificate } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingHttpHeaders } from "node:http";
import type { DetailedPeerCertificate, TLSSocket } from "node:tls";
import { log } from "../logger.ts";
import type { CookieFacts, HttpFacts, RedirectHop, TlsFacts } from "./types.ts";

const DAY = 86_400_000;
// OpenSSL curve names to the NIST ones a certificate policy speaks.
const CURVES: Record<string, string> = { prime256v1: "P-256", secp384r1: "P-384", secp521r1: "P-521" };
const REDACTED = "[redacted]";
const SECRET = new Set(["authorization", "proxy-authorization", "cookie"]);

// got's phase names to the facts document's.
const PHASES: Record<string, keyof HttpFacts["timing"]> = { wait: "wait", dns: "dns", tcp: "tcp", tls: "tls", request: "request", firstByte: "ttfb", download: "download", total: "total" };

export interface Transport {
    httpVersion?: string;
    ip?: string;
    redirectUrls?: URL[];
    timings?: { upload?: number; response?: number; phases?: Record<string, number | undefined> };
    socket?: TLSSocket & { remoteFamily?: string };
}

// Measured phases in milliseconds; a phase the connection skipped stays absent.
export function timingFacts(transport: Transport): HttpFacts["timing"] {
    const timing: HttpFacts["timing"] = {};
    const phases = Object.entries(transport.timings?.phases ?? {});
    for (const [phase, value] of phases) {
        const name = PHASES[phase];
        if (name && value !== undefined) timing[name] = value;
    }
    return timing;
}

type RequestFunction = (url: URL, options: unknown, callback?: unknown) => unknown;
type Hints = NonNullable<HttpFacts["early-hints"]>;

// A got `beforeRequest` hook wrapping the request function got-scraping chose, so each 103 of the last hop lands in `hints`.
export function earlyHintsHook(url: string, hints: Hints): (options: { getRequestFunction(): RequestFunction; request?: RequestFunction }) => void {
    const listen = (request: unknown) =>
        (request as EventEmitter).on("information", (info: { statusCode: number; headers?: IncomingHttpHeaders }) => {
            const link = info.headers?.link;
            log.debug({ url, status: info.statusCode, link }, "informational response received");
            if (info.statusCode === 103) hints.push({ ...(link && { link: [link].flat().join(", ") }) });
        });
    return (options) => {
        hints.length = 0;
        const inner = options.getRequestFunction();
        options.request = (target, native, callback) => {
            const made = inner(target, native, callback);
            if (made instanceof Promise) void made.then(listen);
            else listen(made);
            return made;
        };
    };
}

// Seconds a cookie lives: `Max-Age` first, else `Expires` against `now`, undefined for a session cookie (RFC 6265 §5.3).
function lifetime(flags: Map<string, string | undefined>, now: number): number | undefined {
    const maxAge = Number(flags.get("max-age") || NaN);
    if (Number.isSafeInteger(maxAge)) return maxAge;
    const expires = Date.parse(flags.get("expires") ?? "");
    return Number.isNaN(expires) ? undefined : Math.round((expires - now) / 1000);
}

// Name and flags of each Set-Cookie; values never leave this function.
export function cookieFacts(setCookie: string | string[] | undefined, date?: string | string[]): CookieFacts[] {
    const now = Date.parse(String(date)) || Date.now();
    const lines = setCookie === undefined ? [] : [setCookie].flat();
    return lines.map((line) => {
        const [pair = "", ...attributes] = line.split(";").map((part) => part.trim());
        const flags = new Map(
            attributes.map((attribute) => {
                const [key = "", value] = attribute.split("=", 2);
                return [key.toLowerCase(), value?.trim()];
            }),
        );
        const sameSite = flags.get("samesite");
        const path = flags.get("path");
        const domain = flags.get("domain");
        const maxAge = lifetime(flags, now);
        return { name: pair.split("=", 1)[0] ?? "", secure: flags.has("secure"), "http-only": flags.has("httponly"), ...(sameSite && { "same-site": sameSite }), ...(path !== undefined && { path }), ...(domain !== undefined && { domain }), ...(maxAge !== undefined && { "max-age": maxAge }) };
    });
}

// Cache-status headers a CDN sets, each to a pattern its hit value matches.
const CACHE_HITS: [string, RegExp][] = [
    ["cf-cache-status", /^(?:hit|stale|revalidated|updating)$/i],
    ["x-cache", /\bhit\b/i],
    ["x-vercel-cache", /^(?:hit|stale|prerender)$/i],
    ["cdn-cache", /^hit$/i],
    ["cache-status", /;\s*hit\b/i],
];

// Seconds the response `Date`, taken mid-second, runs ahead of our clock at the midpoint of `sent` and `firstByte`, or undefined when absent, unparsable or served from a cache.
export function dateSkew(url: string, headers: Record<string, string | string[] | undefined>, sent: number | undefined, firstByte: number | undefined): number | undefined {
    const date = Date.parse(String([headers.date].flat()[0] ?? ""));
    const age = Number([headers.age].flat()[0] ?? 0);
    const hit = CACHE_HITS.find(([name, pattern]) => pattern.test(String([headers[name]].flat()[0] ?? "")))?.[0];
    const isCached = age > 0 || hit !== undefined;
    log.debug({ url, date: headers.date, age, hit, sent, firstByte }, "response date read");
    const isMeasured = sent !== undefined && firstByte !== undefined && !isCached && !Number.isNaN(date);
    return isMeasured ? Math.round((date + 500 - (sent + firstByte) / 2) / 1000) : undefined;
}

// One redirect hop to `url`, from the status and raw headers of the response that sent it there.
export function redirectHop(url: string, status: number, raw: Record<string, string | string[] | undefined>): RedirectHop {
    const headers = redactHeaders(raw);
    const by = [headers["x-redirect-by"] ?? headers["redirect-by"]].flat()[0];
    log.debug({ url, status, by }, "redirect hop recorded");
    return { url, status, headers, ...(by && { by }) };
}

// A got `beforeRedirect` hook appending each hop the request follows to `hops`.
export function redirectHook(hops: RedirectHop[]): (options: { url?: URL | string }, response: { statusCode: number; headers: IncomingHttpHeaders }) => void {
    return (options, response) => {
        hops.push(redirectHop(String(options.url), response.statusCode, response.headers));
    };
}

// Response headers with credentials and cookie values replaced, and HTTP/2 pseudo-headers dropped, before anything is stored or reported.
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || name.startsWith(":")) continue;
        if (SECRET.has(name)) out[name] = REDACTED;
        else if (name === "set-cookie") out[name] = [value].flat().map((line) => line.replace(/^([^=;]*)=[^;]*/, (_pair, name: string) => `${name}=${REDACTED}`));
        else out[name] = value;
    }
    return out;
}

// `DNS:a, IP Address:b` to `[a, b]`.
function subjectAltNames(raw: string | undefined): string[] {
    return (raw ?? "").split(",").map((entry) => entry.trim().replace(/^[^:]+:/, "")).filter((entry) => entry.length > 0);
}

function isoDate(raw: string | undefined): string | undefined {
    const time = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

// The leaf's public key as type, size and curve; absent when the certificate does not parse.
function keyFacts(raw: Buffer | undefined): TlsFacts["cert"]["key"] {
    if (!raw?.length) return undefined;
    try {
        const key = new X509Certificate(raw).publicKey;
        const { modulusLength, namedCurve } = key.asymmetricKeyDetails ?? {};
        const type = key.asymmetricKeyType === "ec" ? "EC" : key.asymmetricKeyType?.startsWith("rsa") ? "RSA" : key.asymmetricKeyType === "ed25519" ? "Ed25519" : String(key.asymmetricKeyType);
        return { type, ...(modulusLength && { bits: modulusLength }), ...(namedCurve && { curve: CURVES[namedCurve] ?? namedCurve }) };
    } catch (error) {
        log.debug({ error: String(error) }, "peer certificate key unreadable");
        return undefined;
    }
}

// Signature algorithms from the leaf up to, not including, a self-signed root.
function signatureFacts(leaf: DetailedPeerCertificate): string[] {
    const algorithms: string[] = [];
    try {
        for (let cert = leaf; cert?.raw?.length && algorithms.length < 10; cert = cert.issuerCertificate) {
            const x509 = new X509Certificate(cert.raw);
            if (cert !== leaf && x509.checkIssued(x509)) break;
            algorithms.push(x509.signatureAlgorithm ?? "unknown");
            if (cert.issuerCertificate === cert) break;
        }
    } catch (error) {
        log.debug({ error: String(error), read: algorithms.length }, "peer certificate chain unreadable");
    }
    return algorithms;
}

// This connection's TLS observation; absent on a plain-text socket.
export function tlsFacts(socket: TLSSocket | undefined, now = Date.now()): TlsFacts | undefined {
    if (typeof socket?.getPeerCertificate !== "function") return undefined;
    const cert = socket.getPeerCertificate(true);
    const key = keyFacts(cert.raw);
    const notAfter = isoDate(cert.valid_to);
    const error = socket.authorizationError;
    return {
        ...(socket.getProtocol() && { protocol: socket.getProtocol() as string }),
        ...(socket.getCipher()?.name && { cipher: socket.getCipher().name }),
        ...(socket.alpnProtocol && { alpn: socket.alpnProtocol }),
        authorized: socket.authorized,
        ...(error && { error: String(error) }),
        cert: {
            ...(cert.subject?.CN && { subject: String(cert.subject.CN) }),
            ...((cert.issuer?.O ?? cert.issuer?.CN) && { issuer: String(cert.issuer.O ?? cert.issuer.CN) }),
            ...(isoDate(cert.valid_from) && { "not-before": isoDate(cert.valid_from) }),
            ...(notAfter && { "not-after": notAfter, "days-left": Math.floor((Date.parse(notAfter) - now) / DAY) }),
            san: subjectAltNames(cert.subjectaltname),
            ...(cert.fingerprint256 && { fingerprint256: cert.fingerprint256 }),
            ...(key && { key }),
            ...(cert.raw?.length && { signatures: signatureFacts(cert) }),
        },
    };
}
