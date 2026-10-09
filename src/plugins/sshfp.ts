// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { reason } from "../crawl/fetch.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { records, warnOnce, zoneOf } from "./dns.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

const run = promisify(execFile);
// Seconds ssh-keyscan waits on each connection it opens.
const KEYSCAN_SECONDS = 8;
// Milliseconds before the whole ssh-keyscan run is killed, one connection per key type.
const KEYSCAN_MS = 4 * KEYSCAN_SECONDS * 1000;
// https://www.iana.org/assignments/dns-sshfp-rr-parameters: public key algorithm numbers by key type; 5 is unassigned.
const ALGORITHMS = new Map([
    ["ssh-rsa", 1],
    ["ssh-dss", 2],
    ["ecdsa-sha2-nistp256", 3],
    ["ecdsa-sha2-nistp384", 3],
    ["ecdsa-sha2-nistp521", 3],
    ["ssh-ed25519", 4],
    ["ssh-ed448", 6],
]);
// Fingerprint types of the same registry: 1 SHA-1, 2 SHA-256.
const DIGESTS: Record<number, string> = { 1: "sha1", 2: "sha256" };
// DSA, which OpenSSH no longer reads, so its records are never compared.
const UNREADABLE = 2;

export interface SshfpSettings {
    port: number;
}

interface SshfpRecord {
    algorithm: number;
    hash: number;
    fingerprint: string;
}

// The SSHFP fingerprint of a key blob under `hash`, upper-case hex as dns-packet decodes it.
export function fingerprint(blob: Buffer, hash: number): string {
    return createHash(DIGESTS[hash] ?? "sha256")
        .update(blob)
        .digest("hex")
        .toUpperCase();
}

// Each `host type base64` line of ssh-keyscan output as its key type and RFC 4253 blob.
export function parseKeyscan(output: string): { type: string; blob: Buffer }[] {
    return output.split("\n").flatMap((line) => {
        const [, type, key] = line.trim().split(/\s+/, 3);
        return !type || !key || line.startsWith("#") ? [] : [{ type, blob: Buffer.from(key, "base64") }];
    });
}

// The host keys OpenSSH’s ssh-keyscan reads off `address`; none when the port is closed or silent, which it reports as exit 1.
async function keyscan(address: string, port: number, signal: AbortSignal): Promise<{ type: string; blob: Buffer }[]> {
    try {
        const { stdout } = await run("ssh-keyscan", ["-q", "-T", String(KEYSCAN_SECONDS), "-p", String(port), address], { signal, timeout: KEYSCAN_MS });
        return parseKeyscan(stdout);
    } catch (error) {
        const { code, stdout } = error as NodeJS.ErrnoException & { stdout?: string };
        if (code === "ENOENT" || typeof stdout !== "string" || signal.aborted) throw error;
        log.debug({ address, port, code, error: reason(error) }, "ssh-keyscan exited with an error");
        return parseKeyscan(stdout);
    }
}

// Each comparable record whose key the server does not present, or presents with another digest, with what it served instead.
function mismatches(found: SshfpRecord[], served: { algorithm: number; sha1: string; sha256: string }[]): Record<string, unknown>[] {
    return found.flatMap((record) => {
        const digest = DIGESTS[record.hash] as "sha1" | "sha256" | undefined;
        if (!digest || record.algorithm === UNREADABLE) return [];
        const same = served.filter((key) => key.algorithm === record.algorithm);
        const isMatched = same.some((key) => key[digest] === record.fingerprint);
        log.debug({ algorithm: record.algorithm, hash: record.hash, served: same.length, isMatched }, "SSHFP record compared");
        return isMatched ? [] : [{ ...record, served: same.map((key) => key[digest]) }];
    });
}

// Records naming DSA, and SHA-1 records with no SHA-256 record for the same algorithm.
function deprecated(found: SshfpRecord[]): SshfpRecord[] {
    return found.filter((record) => record.algorithm === UNREADABLE || (record.hash === 1 && found.every((other) => other.algorithm !== record.algorithm || other.hash !== 2)));
}

// The host’s SSHFP records beside the host keys its SSH server presents; nothing when no SSH server answers.
const sshfp: SiteExtractor = {
    id: "sshfp",
    per: "host",
    cached: false,
    resolves: true,
    async extract(host, context: SiteContext) {
        const { port } = context.settings as SshfpSettings;
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const reply = await context.dns.query(host, "SSHFP");
        const found = records<SshfpRecord>(reply, "SSHFP").map(({ data }) => ({ algorithm: data.algorithm, hash: data.hash, fingerprint: data.fingerprint }));
        let keys: { type: string; blob: Buffer }[];
        try {
            keys = await keyscan(await context.address(host), port, context.signal);
        } catch (error) {
            const isMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
            return warnOnce(context.dns, isMissing ? "ssh-keyscan" : `SSH port ${port}`, { host, port, records: found.length, error: reason(error) });
        }
        if (keys.length === 0) return log.debug({ host, port, records: found.length }, "no SSH server, sshfp skipped");
        const served = keys.flatMap(({ type, blob }) => (ALGORITHMS.has(type) ? [{ type, algorithm: ALGORITHMS.get(type) as number, sha1: fingerprint(blob, 1), sha256: fingerprint(blob, 2) }] : []));
        const mismatched = mismatches(found, served);
        log.debug({ host, zone, port, records: found.length, served: served.length, mismatched: mismatched.length, ad: reply.ad }, "sshfp read");
        return {
            zone,
            port,
            authenticated: reply.ad,
            records: found,
            served,
            ...((reply.ad || mismatched.length > 0) && { mismatched }),
            deprecated: deprecated(found),
        };
    },
};

const WITH_RECORDS = { "site.hosts.*.sshfp.records": { type: "array", minItems: 1 } };

const RULES: Record<string, RuleSpec> = {
    "sshfp/mismatch": {
        fact: "site.hosts.*.sshfp.mismatched",
        expect: { maxItems: 0 },
        when: { "site.hosts.*.sshfp.mismatched": { type: "array" } },
        message: "an SSHFP record names a host key the SSH server does not present, so the record is stale after a key rotation or the connection was intercepted (got {got})",
        severity: "error",
        score: 8.8,
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.3",
        fix: "Republish the SSHFP records from the server’s current keys (`ssh-keygen -r {host}` on it), or find what answered in its place.",
    },
    "sshfp/unsigned": {
        fact: "site.hosts.*.sshfp.authenticated",
        expect: { const: true },
        when: WITH_RECORDS,
        message: "the SSHFP records were not authenticated by DNSSEC, so an SSH client must not trust them: the zone is unsigned or the resolver does not validate",
        severity: "warning",
        score: 5.4,
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.4",
        fix: "Sign the zone with DNSSEC, or audit through a validating resolver.",
    },
    "sshfp/missing": {
        fact: "site.hosts.*.sshfp.records",
        expect: { minItems: 1 },
        message: "the host answers SSH but publishes no SSHFP record, so a first connection is trust on first use",
        severity: "info",
        score: 2.2,
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.1",
        fix: "Publish the output of `ssh-keygen -r {host}` in a DNSSEC-signed zone.",
    },
    "sshfp/deprecated": {
        fact: "site.hosts.*.sshfp.deprecated",
        expect: { maxItems: 0 },
        when: WITH_RECORDS,
        message: "an SSHFP record names a DSA key or carries a SHA-1 digest with no SHA-256 one beside it (got {got})",
        severity: "hint",
        score: 0.4,
        docs: "https://www.rfc-editor.org/rfc/rfc6594#section-4.1",
        fix: "Drop DSA records, whose keys FIPS 186-5 no longer approves for signing, and publish a SHA-256 record for every key.",
    },
};

// SSHFP records of every crawled host compared with the host keys its SSH server presents.
export default definePlugin({
    name: "sshfp",
    settings: { type: "object", additionalProperties: false, properties: { port: { type: "integer", minimum: 1, maximum: 65_535, default: 22 } } },
    sites: [sshfp],
    presets: { sshfp: { description: "SSHFP records of every crawled host matched to the host keys its SSH server presents, and whether DNSSEC lets a client trust them", rules: RULES } },
});
