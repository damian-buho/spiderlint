// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Answer } from "dns-packet";
import { Bucket } from "../src/cache/index.ts";
import { dnsClient, type DnsClient, type StoredReply } from "../src/crawl/dns.ts";
import { hostKey, HOST_KEY_ALGORITHMS } from "../src/crawl/ssh.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import sshfp, { fingerprint } from "../src/plugins/sshfp.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { NEVER_SERVED } from "../src/server/policy.ts";
import { serveDns, type DnsFixture } from "./fixtures/dns.ts";
import { ecdsa, ed25519, rsa, serveSsh, type SshFixture, type SshKey } from "./fixtures/ssh.ts";

// RFC 7479 §3: an Ed25519 key in OpenSSH form and its SHA-256 SSHFP record.
const RFC_7479_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const RFC_7479_SHA256 = "A87F1B687AC0E57D2A081A2F282672334D90ED316D2B818CA9580EA384D92401";

function record(name: string, algorithm: number, hash: number, digest: string): Answer {
    return { type: "SSHFP", name, ttl: 300, data: { algorithm, hash, fingerprint: digest } } as unknown as Answer;
}

// The sshfp facts of `host` with SSH on `port` at loopback, `signal` bounding the run.
async function extract(host: string, client: DnsClient, port: number, signal = new AbortController().signal): Promise<unknown> {
    const reject = () => Promise.reject(new Error("no http here"));
    const context: SiteContext = { pages: [], signal, dns: client, settings: { port }, fetch: reject, delegated: reject, link: reject, address: async () => "127.0.0.1" };
    return sshfp.sites?.[0]?.extract(host, context);
}

// Rule IDs the `sshfp` preset reports over one host’s facts, sorted.
function findings(host: string, facts: unknown): string[] {
    const run = runRules([], new Map([["default", compileRulesets(["sshfp"], {})]]), { sitemaps: [], hosts: { [host]: { sshfp: facts } } });
    return run.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("sshfp fingerprint", () => {
    it("hashes the RFC 4253 key blob, matching RFC 7479’s published record", () => {
        assert.equal(fingerprint(Buffer.from(RFC_7479_KEY, "base64"), 2), RFC_7479_SHA256);
        assert.notEqual(fingerprint(Buffer.from(`ssh-ed25519 ${RFC_7479_KEY}`), 2), RFC_7479_SHA256);
    });
});

describe("ssh handshake", () => {
    let keys: SshKey[];
    let server: SshFixture;
    let classic: SshFixture;
    let forged: SshFixture;

    before(async () => {
        keys = [ed25519(), ecdsa(), rsa()];
        [server, classic, forged] = await Promise.all([serveSsh(keys), serveSsh(keys, { kex: ["curve25519-sha256"] }), serveSsh([keys[0] as SshKey], { forger: ed25519() })]);
    });

    after(async () => {
        await Promise.all([server.close(), classic.close(), forged.close()]);
    });

    it("reads each key type the server holds over ML-KEM or curve25519, verified by its signature", async () => {
        for (const fixture of [server, classic]) {
            for (const key of keys) {
                const answer = await hostKey("127.0.0.1", fixture.port, [key.algorithm], AbortSignal.timeout(5000));
                assert.deepEqual(answer.blob, key.blob, key.algorithm);
                assert.equal(answer.banner, "SSH-2.0-fixture");
            }
        }
    });

    it("refuses a key whose signature was made with another one", async () => {
        await assert.rejects(hostKey("127.0.0.1", forged.port, HOST_KEY_ALGORITHMS, AbortSignal.timeout(5000)), /does not verify/);
    });
});

describe("sshfp plugin", () => {
    let key: SshKey;
    let server: SshFixture;
    let stalled: SshFixture;
    let fixture: DnsFixture;
    let client: DnsClient;

    before(async () => {
        key = ed25519();
        const stale = ed25519();
        [server, stalled] = await Promise.all([serveSsh([key]), serveSsh([key], { stall: true })]);
        fixture = await serveDns(true, {
            "match.fixture|SSHFP": { ad: true, answers: [record("match.fixture", 4, 2, fingerprint(key.blob, 2))] },
            "stale.fixture|SSHFP": { ad: true, answers: [record("stale.fixture", 4, 2, fingerprint(stale.blob, 2)), record("stale.fixture", 1, 2, fingerprint(stale.blob, 2))] },
            "unsigned.fixture|SSHFP": { answers: [record("unsigned.fixture", 4, 1, fingerprint(key.blob, 1))] },
        });
        client = dnsClient(fixture.server, new Bucket<StoredReply>("dns", undefined, 60, "off"), true);
    });

    after(async () => {
        await Promise.all([server.close(), stalled.close(), fixture.close()]);
    });

    it("passes a host whose record matches the key it serves", async () => {
        const facts = await extract("match.fixture", client, server.port);
        assert.equal((facts as { served: unknown[] }).served.length, 1);
        assert.deepEqual(findings("match.fixture", facts), []);
    });

    it("reports a record naming a key the server does not present, once", async () => {
        const facts = await extract("stale.fixture", client, server.port);
        assert.equal((facts as { mismatched: unknown[] }).mismatched.length, 2);
        assert.deepEqual(findings("stale.fixture", facts), ["sshfp/mismatch"]);
    });

    it("gives an unauthenticated record no match verdict", async () => {
        const facts = await extract("unsigned.fixture", client, server.port);
        assert.equal((facts as { mismatched?: unknown }).mismatched, undefined);
        assert.deepEqual(findings("unsigned.fixture", facts), ["sshfp/deprecated", "sshfp/unsigned"]);
    });

    it("asks for a record where SSH answers and none is published", async () => {
        assert.deepEqual(findings("other.fixture", await extract("other.fixture", client, server.port)), ["sshfp/missing"]);
    });

    it("says nothing about a host with no SSH server", async () => {
        const closed = await serveSsh([]);
        const { port } = closed;
        await closed.close();
        assert.equal(await extract("match.fixture", client, port), undefined);
    });

    it("abandons a port that accepts and never speaks", async () => {
        const started = Date.now();
        assert.equal(await extract("match.fixture", client, stalled.port, AbortSignal.timeout(500)), undefined);
        assert.ok(Date.now() - started < 5000);
    });

    it("never runs through the scan server", () => {
        assert.deepEqual(compileRulesets(["sshfp"], {}, new Set(NEVER_SERVED)), []);
    });
});
