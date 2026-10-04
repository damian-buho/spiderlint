// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Answer } from "dns-packet";
import { Bucket } from "../src/cache/index.ts";
import { dnsClient, type DnsClient, type StoredReply } from "../src/crawl/dns.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import sshfp, { fingerprint, parseKeyscan } from "../src/plugins/sshfp.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { NEVER_SERVED } from "../src/server/policy.ts";
import { serveDns, type DnsFixture } from "./fixtures/dns.ts";

// RFC 7479 §3: an Ed25519 key in OpenSSH form and its SHA-256 SSHFP record.
const RFC_7479_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIGPKSUTyz1HwHReFVvD5obVsALAgJRNarH4TRpNePnAS";
const RFC_7479_SHA256 = "A87F1B687AC0E57D2A081A2F282672334D90ED316D2B818CA9580EA384D92401";
const BLOB = Buffer.from(RFC_7479_KEY, "base64");
// Ports the fake ssh-keyscan answers on: one key, or a connection that never speaks.
const SERVING = 2201;
const STALLED = 2202;
const CLOSED = 2203;

// An ssh-keyscan stand-in printing the RFC 7479 key on SERVING, hanging on STALLED, and exiting 1 silently elsewhere.
const FAKE = String.raw`#!/usr/bin/env node
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
if (port === ${STALLED}) setTimeout(() => {}, 60_000);
else if (port === ${SERVING}) process.stdout.write("127.0.0.1 ssh-ed25519 ${RFC_7479_KEY}\n");
else process.exitCode = 1;
`;

function record(name: string, algorithm: number, hash: number, digest: string): Answer {
    return { type: "SSHFP", name, ttl: 300, data: { algorithm, hash, fingerprint: digest } } as unknown as Answer;
}

// The sshfp facts of `host` with SSH on `port`, `signal` bounding the run.
async function extract(host: string, client: DnsClient, port: number, signal = new AbortController().signal): Promise<unknown> {
    const reject = () => Promise.reject(new Error("no http here"));
    const context: SiteContext = { pages: [], signal, dns: client, settings: { port }, fetch: reject, delegated: reject, link: reject, cached: reject, address: async () => "127.0.0.1" };
    return sshfp.sites?.[0]?.extract(host, context);
}

// Rule IDs the `sshfp` preset reports over one host’s facts, sorted.
function findings(host: string, facts: unknown): string[] {
    const run = runRules([], new Map([["default", compileRulesets(["sshfp"], {})]]), { sitemaps: [], hosts: { [host]: { sshfp: facts } } });
    return run.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("sshfp fingerprint", () => {
    it("hashes the RFC 4253 key blob, matching RFC 7479’s published record", () => {
        assert.equal(fingerprint(BLOB, 2), RFC_7479_SHA256);
        assert.notEqual(fingerprint(Buffer.from(`ssh-ed25519 ${RFC_7479_KEY}`), 2), RFC_7479_SHA256);
    });

    it("reads keys from ssh-keyscan output and skips its comments", () => {
        assert.deepEqual(parseKeyscan(`# kiota.ch:22 SSH-2.0-OpenSSH_10.2\nkiota.ch ssh-ed25519 ${RFC_7479_KEY}\n\n`), [{ type: "ssh-ed25519", blob: BLOB }]);
    });
});

describe("sshfp plugin", () => {
    let fixture: DnsFixture;
    let client: DnsClient;
    let directory: string;
    let path_: string | undefined;

    before(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-sshfp-"));
        await writeFile(path.join(directory, "ssh-keyscan"), FAKE);
        await chmod(path.join(directory, "ssh-keyscan"), 0o755);
        path_ = process.env.PATH;
        process.env.PATH = `${directory}${path.delimiter}${path_ ?? ""}`;
        fixture = await serveDns(true, {
            "match.fixture|SSHFP": { ad: true, answers: [record("match.fixture", 4, 2, RFC_7479_SHA256)] },
            "stale.fixture|SSHFP": { ad: true, answers: [record("stale.fixture", 4, 2, "00".repeat(32)), record("stale.fixture", 1, 2, "11".repeat(32))] },
            "unsigned.fixture|SSHFP": { answers: [record("unsigned.fixture", 4, 1, fingerprint(BLOB, 1))] },
        });
        client = dnsClient(fixture.server, new Bucket<StoredReply>("dns", undefined, 60, "off"), true);
    });

    after(async () => {
        process.env.PATH = path_;
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("passes a host whose record matches the key it serves", async () => {
        const facts = await extract("match.fixture", client, SERVING);
        assert.equal((facts as { served: unknown[] }).served.length, 1);
        assert.deepEqual(findings("match.fixture", facts), []);
    });

    it("reports records naming keys the server does not present, once per host", async () => {
        const facts = await extract("stale.fixture", client, SERVING);
        assert.equal((facts as { mismatched: unknown[] }).mismatched.length, 2);
        assert.deepEqual(findings("stale.fixture", facts), ["sshfp/mismatch"]);
    });

    it("gives an unauthenticated record no match verdict", async () => {
        const facts = await extract("unsigned.fixture", client, SERVING);
        assert.equal((facts as { mismatched?: unknown }).mismatched, undefined);
        assert.deepEqual(findings("unsigned.fixture", facts), ["sshfp/deprecated", "sshfp/unsigned"]);
    });

    it("asks for a record where SSH answers and none is published", async () => {
        assert.deepEqual(findings("other.fixture", await extract("other.fixture", client, SERVING)), ["sshfp/missing"]);
    });

    it("says nothing about a host with no SSH server", async () => {
        assert.equal(await extract("match.fixture", client, CLOSED), undefined);
    });

    it("abandons a port that accepts and never speaks", async () => {
        const started = Date.now();
        assert.equal(await extract("match.fixture", client, STALLED, AbortSignal.timeout(500)), undefined);
        assert.ok(Date.now() - started < 5000);
    });

    it("skips the check when ssh-keyscan is not installed", async () => {
        process.env.PATH = directory.replace("sshfp", "absent");
        try {
            assert.equal(await extract("match.fixture", client, SERVING), undefined);
        } finally {
            process.env.PATH = `${directory}${path.delimiter}${path_ ?? ""}`;
        }
    });

    it("never runs through the scan server", () => {
        assert.deepEqual(compileRulesets(["sshfp"], {}, new Set(NEVER_SERVED)), []);
    });
});
