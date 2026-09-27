// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TlsProber } from "../src/crawl/tls-probe.ts";
import { withProbe } from "../src/facts/browser.ts";
import type { DnsClient } from "../src/crawl/dns.ts";
import type { SiteFacts, TlsFacts } from "../src/facts/types.ts";
import { log } from "../src/logger.ts";
import tlsProbe from "../src/plugins/tls-probe.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { serveTls, type TlsFixture } from "./fixtures/tls.ts";

const fixture = await serveTls();

describe("TLS probe", { skip: !fixture && "openssl is not on PATH" }, () => {
    let site: TlsFixture;

    before(() => {
        site = fixture as TlsFixture;
    });

    after(() => site.close());

    it("reads what Chromium does not report, once per host and address", async () => {
        const prober = new TlsProber(true);
        const url = new URL(`${site.origin}/a`);
        const [first, second] = await Promise.all([prober.facts(url, "127.0.0.1"), prober.facts(new URL(`${site.origin}/b`), "127.0.0.1")]);
        assert.equal(first, second);
        assert.equal(prober.probes, 1);
        assert.equal(first?.alpn, "h2");
        assert.ok(first?.cipher && first.cert.fingerprint256);
        assert.deepEqual(first?.cert.san, ["localhost", "127.0.0.1"]);
        assert.equal(first?.authorized, false, "a self-signed certificate is judged, never enforced");
    });

    it("refuses a private address unless allowed, and probes nothing off https", async () => {
        const prober = new TlsProber(false);
        assert.equal(await prober.facts(new URL(`${site.origin}/`), "127.0.0.1"), undefined);
        assert.equal(await prober.facts(new URL("http://localhost/"), "127.0.0.1"), undefined);
        assert.equal(prober.probes, 1);
    });
});

describe("probed browser TLS", () => {
    const cert = { subject: "a.test", "not-after": "2027-01-01T00:00:00.000Z", san: [] };
    const seen: TlsFacts = { protocol: "TLSv1.3", authorized: true, cert };
    const probed: TlsFacts = { protocol: "TLSv1.2", cipher: "TLS_AES_128_GCM_SHA256", alpn: "h2", authorized: true, cert: { ...cert, san: ["a.test"], fingerprint256: "AB" } };

    it("completes Chromium’s observation and keeps its protocol when both saw one certificate", () => {
        assert.deepEqual(withProbe("https://a.test/", seen, "TLS 1.3", probed), { tls: { ...probed, protocol: "TLSv1.3" }, version: "2.0" });
        assert.equal(withProbe("https://a.test/", seen, "TLS 1.3", { ...probed, alpn: undefined }).version, "1.1");
    });

    it("keeps Chromium’s own when the probe met another certificate", () => {
        assert.deepEqual(withProbe("https://a.test/", seen, "TLS 1.3", { ...probed, cert: { ...probed.cert, subject: "b.test" } }), { tls: seen });
    });

    it("reads HTTP/3 off QUIC and HTTP/1.1 off plain text", () => {
        assert.equal(withProbe("https://a.test/", seen, "QUIC", undefined).version, "3.0");
        // eslint-disable-next-line unicorn/prefer-https -- a plain-text page is the case under test
        assert.deepEqual(withProbe("http://a.test/", undefined, undefined, undefined), { version: "1.1" });
    });
});

// The `tls-probe` facts of `origin`, connecting to 127.0.0.1 whatever `localhost` resolves to.
async function probed(origin: string): Promise<unknown> {
    const [extractor] = tlsProbe.sites ?? [];
    const signal = AbortSignal.timeout(60_000);
    return extractor?.extract(origin, { pages: [], signal, dns: undefined as unknown as DnsClient, fetch: () => Promise.reject(new Error("no http here")), link: () => Promise.reject(new Error("no http here")), address: async () => "127.0.0.1" });
}

// `[rule, severity]` of each `tls-probe` finding over one origin’s facts.
function judged(origin: string, facts: unknown): [string, string][] {
    const site: SiteFacts = { sitemaps: [], origins: { [origin]: { "tls-probe": facts } } };
    return runRules([], new Map([["default", compileRulesets(["tls-probe"], {})]]), site).findings.map((finding): [string, string] => [finding.rule, finding.severity]);
}

describe("tls-probe plugin", { skip: !fixture && "openssl is not on PATH" }, () => {
    it("fails a server that still accepts TLS 1.1", async () => {
        const legacy = await serveTls(["http/1.1"], { minVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0" });
        try {
            const facts = await probed(legacy?.origin ?? "");
            assert.ok((facts as { legacy: string[] }).legacy.includes("TLSv1.1"));
            assert.deepEqual(judged(legacy?.origin ?? "", facts), [["tls-probe/legacy-protocols", "warning"]]);
        } finally {
            await legacy?.close();
        }
    });

    it("passes a TLS 1.3-only server with a complete chain", async () => {
        const modern = await serveTls(["http/1.1"], { minVersion: "TLSv1.3" });
        try {
            const facts = await probed(modern?.origin ?? "");
            assert.deepEqual(facts, { address: "127.0.0.1", legacy: [], chain: { sent: 1, complete: true }, ocsp: { responder: false, stapled: false }, "early-data": false });
            assert.deepEqual(judged(modern?.origin ?? "", facts), []);
        } finally {
            await modern?.close();
        }
    });

    it("skips with one warning where openssl is not on PATH", async (context) => {
        const warn = context.mock.method(log, "warn");
        const path = process.env.PATH;
        process.env.PATH = "/nonexistent";
        try {
            assert.equal(await probed("https://localhost:9"), undefined);
            assert.equal(await probed("https://localhost:9"), undefined);
        } finally {
            process.env.PATH = path;
        }
        assert.equal(warn.mock.calls.filter((call) => String(call.arguments[1]).includes("openssl not found")).length, 1);
    });
});
