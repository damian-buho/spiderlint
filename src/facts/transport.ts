// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { TLSSocket } from "node:tls";
import type { CookieFacts, HttpFacts, TlsFacts } from "./types.ts";

const DAY = 86_400_000;
const REDACTED = "[redacted]";
const SECRET = new Set(["authorization", "proxy-authorization", "cookie"]);

// got's phase names to the facts document's.
const PHASES: Record<string, keyof HttpFacts["timing"]> = { wait: "wait", dns: "dns", tcp: "tcp", tls: "tls", request: "request", firstByte: "ttfb", download: "download", total: "total" };

export interface Transport {
    httpVersion?: string;
    ip?: string;
    redirectUrls?: URL[];
    timings?: { phases?: Record<string, number | undefined> };
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

// Name and flags of each Set-Cookie; values never leave this function.
export function cookieFacts(setCookie: string | string[] | undefined): CookieFacts[] {
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
        return { name: pair.split("=", 1)[0] ?? "", secure: flags.has("secure"), httpOnly: flags.has("httponly"), ...(sameSite && { sameSite }) };
    });
}

// Response headers with credentials and cookie values replaced before anything is stored or reported.
export function redactHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        if (SECRET.has(name)) out[name] = REDACTED;
        else if (name === "set-cookie") out[name] = cookieFacts(value).map((cookie) => `${cookie.name}=${REDACTED}`);
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

// This connection's TLS observation; absent on a plain-text socket.
export function tlsFacts(socket: TLSSocket | undefined, now = Date.now()): TlsFacts | undefined {
    if (typeof socket?.getPeerCertificate !== "function") return undefined;
    const cert = socket.getPeerCertificate();
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
            ...(isoDate(cert.valid_from) && { notBefore: isoDate(cert.valid_from) }),
            ...(notAfter && { notAfter, daysLeft: Math.floor((Date.parse(notAfter) - now) / DAY) }),
            san: subjectAltNames(cert.subjectaltname),
            ...(cert.fingerprint256 && { fingerprint256: cert.fingerprint256 }),
        },
    };
}
