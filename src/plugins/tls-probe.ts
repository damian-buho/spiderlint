// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCACertificates } from "node:tls";
import { reason } from "../crawl/fetch.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { scan } from "./tls-scan.ts";
import { definePlugin, type SiteExtractor } from "./types.ts";

const TIMEOUT_MS = 10_000;

// Milliseconds one origin’s scan may take: up to about 150 handshakes.
const SCAN_MS = 180_000;

// Whether `openssl` runs, per PATH, so a missing tool warns once.
const available = new Map<string, Promise<boolean>>();

interface Run {
    code: number | null;
    output: string;
}

interface Settings {
    scan: boolean;
}

// One `openssl` run with `input` on stdin, killed on `signal` or after the timeout.
function openssl(parameters: string[], input: string, signal: AbortSignal): Promise<Run> {
    return new Promise((resolve, reject) => {
        const child = spawn("openssl", parameters, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
        child.stdin.end(input);
    });
}

// Whether `openssl` runs; warns when it does not.
async function isRunnable(): Promise<boolean> {
    try {
        const run = await openssl(["version"], "", AbortSignal.timeout(TIMEOUT_MS));
        return run.code === 0;
    } catch (error) {
        log.warn({ tool: "openssl", error: reason(error) }, "openssl not found; tls-probe early data skipped");
        return false;
    }
}

// Whether `openssl` is on PATH, asked once per PATH so a missing tool warns once.
function opensslFound(): Promise<boolean> {
    const key = process.env.PATH ?? "";
    let known = available.get(key);
    if (!known) {
        known = isRunnable();
        available.set(key, known);
    }
    return known;
}

// The `s_client` arguments reaching `host` at `address`.
function target(host: string, port: string, address: string): string[] {
    return ["s_client", "-connect", `${address.includes(":") ? `[${address}]` : address}:${port}`, "-servername", host];
}

function isIssuedBy(certificate: X509Certificate, issuer: X509Certificate): boolean {
    return certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);
}

// Whether each sent certificate is issued by the next, and the last is a root or issued by a trusted one.
function chainOf(certificates: X509Certificate[]): { sent: number; complete: boolean } | undefined {
    const last = certificates.at(-1);
    if (!last) return;
    const isLinked = certificates.slice(0, -1).every((certificate, index) => isIssuedBy(certificate, certificates[index + 1] as X509Certificate));
    const roots = [...getCACertificates("default"), ...getCACertificates("system")].map((pem) => new X509Certificate(pem));
    const isAnchored = isIssuedBy(last, last) || roots.some((root) => isIssuedBy(last, root));
    return { sent: certificates.length, complete: isLinked && isAnchored };
}

// Whether a DER OCSPResponse says `successful` (RFC 6960 §4.2.1): its first element, an ENUMERATED, is 0.
function isSuccessful(response: Buffer | undefined): boolean {
    if (!response || response[0] !== 0x30) return false;
    const at = 2 + ((response[1] ?? 0) & 0x80 ? (response[1] ?? 0) & 0x7f : 0);
    return response[at] === 0x0a && response[at + 1] === 1 && response[at + 2] === 0;
}

// Whether a TLS 1.3 session resumed with early data had it accepted; `false` when no ticket allows it.
async function isEarlyDataAccepted(host: string, port: string, address: string, signal: AbortSignal): Promise<boolean> {
    const directory = await mkdtemp(path.join(tmpdir(), "spiderlint-early-"));
    const [session, data] = [path.join(directory, "session.pem"), path.join(directory, "early.txt")];
    const request = `HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
    try {
        await openssl([...target(host, port, address), "-tls1_3", "-ign_eof", "-sess_out", session], request, signal);
        let ticket = "";
        try {
            ticket = await readFile(session, "utf8");
        } catch (error) {
            log.debug({ host, port, error: reason(error) }, "session file unreadable");
        }
        if (!ticket) {
            log.debug({ host, port }, "no session ticket; early data not tried");
            return false;
        }
        await writeFile(data, request);
        const resumed = await openssl([...target(host, port, address), "-tls1_3", "-ign_eof", "-sess_in", session, "-early_data", data], "", signal);
        const verdict = /Early data was (accepted|rejected|not sent)/.exec(resumed.output)?.[1];
        log.debug({ host, port, verdict }, "early data tried");
        return verdict === "accepted";
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

// Protocols, suites, groups and negotiation-level weaknesses of one https origin from hand-built hellos, with its chain, OCSP stapling and, through `openssl s_client`, TLS 1.3 early data.
const probe: SiteExtractor = {
    id: "tls-probe",
    per: "origin",
    resolves: true,
    timeout: SCAN_MS,
    async extract(origin, context) {
        const url = new URL(origin);
        if (url.protocol !== "https:") return;
        const host = url.hostname.replaceAll(/^\[|\]$/g, "");
        const port = url.port || "443";
        const address = await context.address(host);
        const isFull = (context.settings as Settings | undefined)?.scan !== false;
        const { certificates = [], ocsp, ...scanned } = await scan({ host, address, port: Number(port), signal: context.signal }, isFull);
        if (scanned.protocols.length === 0) throw new Error(`no handshake with ${host}:${port}`);
        const sent = certificates.map((der) => new X509Certificate(der));
        const chain = chainOf(sent);
        const responder = sent[0]?.infoAccess?.includes("OCSP - URI:") ?? false;
        const isEarly = scanned.protocols.includes("TLSv1.3") && (await opensslFound()) ? await isEarlyDataAccepted(host, port, address, context.signal) : undefined;
        log.debug({ origin, address, isFull, protocols: scanned.protocols, chain, responder, isStapled: isSuccessful(ocsp), isEarly }, "tls probed");
        return { address, ...scanned, ...(chain && { chain }), ...(sent.length > 0 && { ocsp: { responder, stapled: isSuccessful(ocsp) } }), ...(isEarly !== undefined && { "early-data": isEarly }) };
    },
};

const RULES: Record<string, RuleSpec> = {
    "tls-probe/legacy-protocols": {
        fact: "site.origins.*.tls-probe.legacy",
        expect: { maxItems: 0 },
        message: "the server still accepts {got}, which RFC 6176, RFC 7568 and RFC 8996 retire",
        severity: "error",
        score: 9.2,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-3.1.1",
        fix: "Disable SSLv3, TLS 1.0 and TLS 1.1; keep only TLS 1.2 and 1.3.",
    },
    "tls-probe/insecure-ciphers": {
        fact: "site.origins.*.tls-probe.insecure-ciphers",
        expect: { maxItems: 0 },
        when: { "site.origins.*.tls-probe.insecure-ciphers": { type: "array" } },
        message: "the server accepts suites broken outright: {got}",
        severity: "error",
        score: 9.4,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-4.1",
        fix: "Remove NULL, RC4, 3DES and other broken cipher suites from the server config.",
    },
    "tls-probe/vulnerabilities": {
        fact: "site.origins.*.tls-probe.vulnerabilities",
        expect: { maxItems: 0 },
        when: { "site.origins.*.tls-probe.vulnerabilities": { type: "array" } },
        message: "what the server negotiates leaves it open to {got}",
        severity: "error",
        score: 9.6,
        docs: "https://www.rfc-editor.org/rfc/rfc7457",
        fix: "Update the TLS library, and disable the protocol, suite or extension each named attack needs.",
    },
    "tls-probe/weak-ciphers": {
        fact: "site.origins.*.tls-probe.weak-ciphers",
        expect: { maxItems: 0 },
        when: { "site.origins.*.tls-probe.weak-ciphers": { type: "array" } },
        message: "the server accepts suites without forward secrecy, with CBC or with a 64-bit block: {got}",
        severity: "warning",
        score: 6.2,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-4.2",
        fix: "Keep only AEAD suites that offer forward secrecy (ECDHE).",
    },
    "tls-probe/forward-secrecy": {
        fact: "site.origins.*.tls-probe.forward-secrecy",
        expect: { const: "all" },
        when: { "site.origins.*.tls-probe.forward-secrecy": { type: "string" } },
        message: "{got} of the accepted suites give forward secrecy, where all should",
        severity: "warning",
        score: 5.8,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-7.3",
        fix: "Configure only ECDHE suites so every handshake offers forward secrecy.",
    },
    "tls-probe/weak-dh": {
        fact: "site.origins.*.tls-probe.dh-bits",
        expect: { minimum: 2048 },
        when: { "site.origins.*.tls-probe.dh-bits": { type: "number" } },
        message: "the server’s DHE prime has {got} bits, short of 2048",
        severity: "warning",
        score: [[512, 6.4], [1024, 5.4], [2047, 3.4]],
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-4.5",
        fix: "Use a DH group of at least 2048 bits, or drop the DHE suites for ECDHE.",
    },
    "tls-probe/compression": {
        fact: "site.origins.*.tls-probe.compression",
        expect: { const: false },
        when: { "site.origins.*.tls-probe.compression": { type: "boolean" } },
        message: "the server compresses TLS records, through which CRIME reads secrets",
        severity: "warning",
        score: 6,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-3.3",
        fix: "Disable TLS compression.",
    },
    "tls-probe/secure-renegotiation": {
        fact: "site.origins.*.tls-probe.secure-renegotiation",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.secure-renegotiation": { type: "boolean" } },
        message: "the server does not answer renegotiation_info, so a renegotiation can be spliced into a session",
        severity: "warning",
        score: 5.2,
        docs: "https://www.rfc-editor.org/rfc/rfc5746",
        fix: "Enable secure renegotiation in the TLS library.",
    },
    "tls-probe/server-cipher-order": {
        fact: "site.origins.*.tls-probe.server-order",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.weak-ciphers": { minItems: 1 } },
        message: "the server lets the client pick a weak suite over a strong one",
        severity: "info",
        score: 2.8,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-4.2.1",
        fix: "Set the server to prefer its own strong suites over the client’s list.",
    },
    "tls-probe/fallback-scsv": {
        fact: "site.origins.*.tls-probe.fallback-scsv",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.fallback-scsv": { type: "boolean" } },
        message: "the server accepts a needless fallback to an older version instead of refusing it",
        severity: "info",
        score: 2.4,
        docs: "https://www.rfc-editor.org/rfc/rfc7507",
        fix: "Enable TLS_FALLBACK_SCSV in the TLS library.",
    },
    "tls-probe/tls13-missing": {
        fact: "site.origins.*.tls-probe.protocols",
        expect: { contains: { const: "TLSv1.3" } },
        message: "the server offers {got} and no TLS 1.3",
        severity: "info",
        score: 2.2,
        docs: "https://www.rfc-editor.org/rfc/rfc9325#section-3.1.1",
        fix: "Enable TLS 1.3 in the server configuration.",
    },
    "tls-probe/chain-complete": {
        fact: "site.origins.*.tls-probe.chain.complete",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.chain": { type: "object" } },
        message: "the server does not send the intermediate certificates its chain needs, so clients that have not cached them fail",
        severity: "error",
        score: 8,
        docs: "https://www.rfc-editor.org/rfc/rfc8446#section-4.4.2",
        fix: "Configure the server to serve the full certificate chain, including intermediates.",
    },
    "tls-probe/ocsp-stapling": {
        fact: "site.origins.*.tls-probe.ocsp.stapled",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.ocsp.responder": true },
        message: "the certificate names an OCSP responder but the server staples no response, so each client asks the CA",
        severity: "info",
        score: 1.8,
        docs: "https://www.rfc-editor.org/rfc/rfc6066#section-8",
        fix: "Enable OCSP stapling so the server attaches the CA’s response to handshakes.",
    },
    "tls-probe/early-data": {
        fact: "site.origins.*.tls-probe.early-data",
        expect: { const: false },
        when: { "site.origins.*.tls-probe.early-data": { type: "boolean" } },
        message: "the server accepts TLS 1.3 early data, which an attacker can replay; non-idempotent requests must answer 425",
        severity: "info",
        score: 2.6,
        docs: "https://www.rfc-editor.org/rfc/rfc8470",
        fix: "Disable early data, or answer 425 Too Early to non-idempotent requests.",
    },
};

// Hand-built handshakes per https origin, for what one connection does not show.
export default definePlugin({
    name: "tls-probe",
    settings: { type: "object", properties: { scan: { type: "boolean", default: true } }, additionalProperties: false },
    sites: [probe],
    presets: { "tls-probe": { description: "Protocols, cipher suites, groups, negotiation weaknesses, chain completeness, OCSP stapling and early data of every https origin", rules: RULES } },
});
