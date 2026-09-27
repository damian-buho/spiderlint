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
import { definePlugin, type SiteExtractor } from "./types.ts";

const TIMEOUT_MS = 10_000;

// Versions RFC 8996 deprecates, with the `s_client` flag that forces each.
const LEGACY = [["TLSv1", "-tls1"], ["TLSv1.1", "-tls1_1"]] as const;

// Whether `openssl` runs, per PATH, so a missing tool warns once.
const available = new Map<string, Promise<boolean>>();

interface Run {
    code: number | null;
    output: string;
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
        log.warn({ tool: "openssl", error: reason(error) }, "openssl not found; tls-probe skipped");
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

// Whether a handshake forced to one version completed.
function isAccepted(run: Run): boolean {
    return run.code === 0 && !/Cipher is \(NONE\)/.test(run.output);
}

// The certificates the server sent, leaf first.
function sent(output: string): X509Certificate[] {
    return output.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).map((match) => new X509Certificate(match[0])).toArray();
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

// Legacy versions accepted, OCSP stapling, chain completeness and TLS 1.3 early data of one https origin, through `openssl s_client`.
const probe: SiteExtractor = {
    id: "tls-probe",
    per: "origin",
    resolves: true,
    async extract(origin, context) {
        const url = new URL(origin);
        if (url.protocol !== "https:" || !(await opensslFound())) return;
        const host = url.hostname.replaceAll(/^\[|\]$/g, "");
        const port = url.port || "443";
        const address = await context.address(host);
        const legacy: string[] = [];
        for (const [version, flag] of LEGACY) {
            const run = await openssl([...target(host, port, address), flag, "-cipher", "DEFAULT@SECLEVEL=0"], "", context.signal);
            log.debug({ origin, version, code: run.code }, "legacy version tried");
            if (isAccepted(run)) legacy.push(version);
        }
        const current = await openssl([...target(host, port, address), "-status", "-showcerts"], "", context.signal);
        if (!isAccepted(current)) throw new Error(`no handshake with ${host}:${port}`);
        const certificates = sent(current.output);
        const chain = chainOf(certificates);
        const responder = certificates[0]?.infoAccess?.includes("OCSP - URI:") ?? false;
        const isStapled = /OCSP Response Status: successful/.test(current.output);
        const isEarly = await isEarlyDataAccepted(host, port, address, context.signal);
        log.debug({ origin, address, legacy, chain, responder, isStapled, isEarly }, "tls probed");
        return { address, legacy, ...(chain && { chain }), ocsp: { responder, stapled: isStapled }, "early-data": isEarly };
    },
};

const RULES: Record<string, RuleSpec> = {
    "tls-probe/legacy-protocols": {
        fact: "site.origins.*.tls-probe.legacy",
        expect: { maxItems: 0 },
        message: "the server still accepts {got}, which RFC 8996 deprecates",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8996",
    },
    "tls-probe/chain-complete": {
        fact: "site.origins.*.tls-probe.chain.complete",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.chain": { type: "object" } },
        message: "the server does not send the intermediate certificates its chain needs, so clients that have not cached them fail",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc8446#section-4.4.2",
    },
    "tls-probe/ocsp-stapling": {
        fact: "site.origins.*.tls-probe.ocsp.stapled",
        expect: { const: true },
        when: { "site.origins.*.tls-probe.ocsp.responder": true },
        message: "the certificate names an OCSP responder but the server staples no response, so each client asks the CA",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc6066#section-8",
    },
    "tls-probe/early-data": {
        fact: "site.origins.*.tls-probe.early-data",
        expect: { const: false },
        message: "the server accepts TLS 1.3 early data, which an attacker can replay; non-idempotent requests must answer 425",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc8470",
    },
};

// Dedicated handshakes per https origin through `openssl s_client`, for what one connection does not show.
export default definePlugin({
    name: "tls-probe",
    sites: [probe],
    presets: { "tls-probe": { description: "Legacy TLS versions, chain completeness, OCSP stapling and early data, through openssl", rules: RULES } },
});
