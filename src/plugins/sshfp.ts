// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { delay, reason } from "../crawl/fetch.ts";
import { Fields, HOST_KEY_ALGORITHMS, hostKey, Unreachable, type HostKey } from "../crawl/ssh.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { records, warnOnce, zoneOf } from "./dns.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

const ATTEMPTS = 2;
// Milliseconds one handshake may take, connect included.
const SSH_MS = 8000;
// https://www.iana.org/assignments/dns-sshfp-rr-parameters: public key algorithm numbers by key type; 5 is unassigned.
const ALGORITHMS = new Map([["ssh-rsa", 1], ["ssh-dss", 2], ["ecdsa-sha2-nistp256", 3], ["ecdsa-sha2-nistp384", 3], ["ecdsa-sha2-nistp521", 3], ["ssh-ed25519", 4], ["ssh-ed448", 6]]);
// Signature algorithm names a server lists for each key type it holds.
const SIGNERS: Record<string, string> = { "rsa-sha2-512": "ssh-rsa", "rsa-sha2-256": "ssh-rsa", "ssh-rsa": "ssh-rsa" };
// Fingerprint types of the same registry: 1 SHA-1, 2 SHA-256.
const DIGESTS: Record<number, string> = { 1: "sha1", 2: "sha256" };

export interface SshfpSettings {
    port: number;
}

interface SshfpRecord {
    algorithm: number;
    hash: number;
    fingerprint: string;
}

// The key type behind a host key algorithm name.
function keyType(name: string): string {
    return SIGNERS[name] ?? name;
}

// The SSHFP fingerprint of a key blob under `hash`, upper-case hex as dns-packet decodes it.
export function fingerprint(blob: Buffer, hash: number): string {
    return createHash(DIGESTS[hash] ?? "sha256").update(blob).digest("hex").toUpperCase();
}

// One handshake retried once with backoff and jitter; a port that refuses or never accepts is no SSH and is not retried.
async function attempt(address: string, port: number, algorithms: string[], signal: AbortSignal): Promise<HostKey> {
    for (let tries = 0; ; tries += 1) {
        try {
            return await hostKey(address, port, algorithms, AbortSignal.any([signal, AbortSignal.timeout(SSH_MS)]));
        } catch (error) {
            const isLast = tries === ATTEMPTS - 1 || error instanceof Unreachable || signal.aborted;
            log.debug({ address, port, tries, isLast, error: reason(error) }, "SSH handshake failed");
            if (isLast) throw error;
            await sleep(delay(tries), undefined, { signal });
        }
    }
}

// Every key the server presents that this client can verify, one handshake per key type, and the types it lists but cannot be checked.
async function servedKeys(address: string, port: number, signal: AbortSignal): Promise<{ banner: string; keys: { type: string; blob: Buffer }[]; unchecked: string[] }> {
    const first = await attempt(address, port, HOST_KEY_ALGORITHMS, signal);
    const keys = first.blob ? [{ type: new Fields(first.blob).text(), blob: first.blob }] : [];
    const others = Map.groupBy(first.offered.filter((name) => HOST_KEY_ALGORITHMS.includes(name)), (name) => keyType(name));
    for (const [type, names] of others) {
        if (keys.some((key) => key.type === type)) continue;
        const { blob } = await attempt(address, port, names, signal);
        log.debug({ address, port, type, isRead: blob !== undefined }, "SSH host key read");
        if (blob) keys.push({ type, blob });
    }
    const unchecked = [...new Set(first.offered.map((name) => keyType(name)))].filter((type) => keys.every((key) => key.type !== type));
    return { banner: first.banner, keys, unchecked };
}

// Each record whose key the server does not present, or presents with another digest, with what it served instead.
function mismatches(found: SshfpRecord[], served: { algorithm: number; sha1: string; sha256: string }[], unchecked: number[]): Record<string, unknown>[] {
    return found.flatMap((record) => {
        const digest = DIGESTS[record.hash];
        if (!digest || unchecked.includes(record.algorithm)) return [];
        const same = served.filter((key) => key.algorithm === record.algorithm);
        const isMatched = same.some((key) => key[digest as "sha1" | "sha256"] === record.fingerprint);
        log.debug({ algorithm: record.algorithm, hash: record.hash, served: same.length, isMatched }, "SSHFP record compared");
        return isMatched ? [] : [{ ...record, served: same.map((key) => key[digest as "sha1" | "sha256"]) }];
    });
}

// Records naming DSA, and SHA-1 records with no SHA-256 record for the same algorithm.
function deprecated(found: SshfpRecord[]): SshfpRecord[] {
    return found.filter((record) => record.algorithm === 2 || (record.hash === 1 && found.every((other) => other.algorithm !== record.algorithm || other.hash !== 2)));
}

// The host’s SSHFP records beside the host keys its SSH server proves it holds; nothing when the port does not answer.
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
        let probed: Awaited<ReturnType<typeof servedKeys>>;
        try {
            probed = await servedKeys(await context.address(host), port, context.signal);
        } catch (error) {
            const fields = { host, port, records: found.length, error: reason(error) };
            return error instanceof Unreachable ? log.debug(fields, "no SSH server, sshfp skipped") : warnOnce(context.dns, `SSH port ${port}`, fields);
        }
        const served = probed.keys.map(({ type, blob }) => ({ type, algorithm: ALGORITHMS.get(type) ?? 0, sha1: fingerprint(blob, 1), sha256: fingerprint(blob, 2) }));
        const unchecked = probed.unchecked.map((type) => ALGORITHMS.get(type)).filter((algorithm) => algorithm !== undefined);
        const mismatched = mismatches(found, served, unchecked);
        log.debug({ host, zone, port, records: found.length, served: served.length, unchecked, mismatched: mismatched.length, ad: reply.ad }, "sshfp read");
        return {
            zone,
            port,
            banner: probed.banner,
            authenticated: reply.ad,
            records: found,
            served,
            ...(unchecked.length > 0 && { unchecked }),
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
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.3",
        fix: "Republish the SSHFP records from the server’s current keys (`ssh-keygen -r {host}` on it), or find what answered in its place.",
    },
    "sshfp/unsigned": {
        fact: "site.hosts.*.sshfp.authenticated",
        expect: { const: true },
        when: WITH_RECORDS,
        message: "the SSHFP records were not authenticated by DNSSEC, so an SSH client must not trust them: the zone is unsigned or the resolver does not validate",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.4",
        fix: "Sign the zone with DNSSEC, or audit through a validating resolver.",
    },
    "sshfp/missing": {
        fact: "site.hosts.*.sshfp.records",
        expect: { minItems: 1 },
        message: "the host answers SSH but publishes no SSHFP record, so a first connection is trust on first use",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc4255#section-2.1",
        fix: "Publish the output of `ssh-keygen -r {host}` in a DNSSEC-signed zone.",
    },
    "sshfp/deprecated": {
        fact: "site.hosts.*.sshfp.deprecated",
        expect: { maxItems: 0 },
        when: WITH_RECORDS,
        message: "an SSHFP record names a DSA key or carries a SHA-1 digest with no SHA-256 one beside it (got {got})",
        severity: "hint",
        docs: "https://www.rfc-editor.org/rfc/rfc6594#section-4.1",
        fix: "Drop DSA records, whose keys FIPS 186-5 no longer approves for signing, and publish a SHA-256 record for every key.",
    },
};

// SSHFP records of every crawled host compared with the host keys its SSH server proves it holds.
export default definePlugin({
    name: "sshfp",
    settings: { type: "object", additionalProperties: false, properties: { port: { type: "integer", minimum: 1, maximum: 65_535, default: 22 } } },
    sites: [sshfp],
    presets: { sshfp: { description: "SSHFP records of every crawled host matched to the host keys its SSH server presents, and whether DNSSEC lets a client trust them", rules: RULES } },
});
