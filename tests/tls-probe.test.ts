// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { TlsProber } from "../src/crawl/tls-probe.ts";
import { withProbe } from "../src/facts/browser.ts";
import type { DnsClient } from "../src/crawl/dns.ts";
import type { SiteFacts, TlsFacts } from "../src/facts/types.ts";
import { ConfigError } from "../src/config/index.ts";
import { log } from "../src/logger.ts";
import { loadPlugins, siteExtractorsFor } from "../src/plugins/index.ts";
import tlsProbe from "../src/plugins/tls-probe.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { certificate, serveTls, type TlsFixture } from "./fixtures/tls.ts";
import { serveScripted } from "./fixtures/tls-scripted.ts";

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
async function probed(origin: string, settings?: unknown): Promise<Record<string, unknown> | undefined> {
    const [extractor] = tlsProbe.sites ?? [];
    const signal = AbortSignal.timeout(60_000);
    return extractor?.extract(origin, { pages: [], signal, settings: settings ?? { scan: true }, dns: undefined as unknown as DnsClient, fetch: () => Promise.reject(new Error("no http here")), link: () => Promise.reject(new Error("no http here")), address: async () => "127.0.0.1" }) as Promise<Record<string, unknown> | undefined>;
}

// `[rule, severity]` of each `tls-probe` finding over one origin’s facts, sorted.
function judged(origin: string, facts: unknown): [string, string][] {
    const site: SiteFacts = { sitemaps: [], origins: { [origin]: { "tls-probe": facts } } };
    return runRules([], new Map([["default", compileRulesets(["tls-probe"], {})]]), site).findings.map((finding): [string, string] => [finding.rule, finding.severity]).toSorted(([a], [b]) => a.localeCompare(b));
}

// A minimal OCSPResponse whose status is `successful`.
const OCSP_OK = Buffer.from("30030a0100", "hex");

describe("tls-probe plugin", { skip: !fixture && "openssl is not on PATH" }, () => {
    it("enumerates what Node cannot serve: SSLv2, SSLv3, RC4, export suites, compression and a short DHE prime", async () => {
        const pem = certificate()?.cert as Buffer;
        const server = await serveScripted({ versions: { 0x03_00: [0x00_05, 0x00_0a, 0x00_2f], 0x03_01: [0x00_03, 0x00_33, 0x00_2f, 0x00_05] }, kinds: [0x01_00_80], isCompressing: true, dhBits: 1024, certificate: new X509Certificate(pem).raw });
        try {
            const origin = `https://localhost:${server.port}`;
            const facts = await probed(origin);
            assert.deepEqual(facts?.protocols, ["SSLv2", "SSLv3", "TLSv1"]);
            assert.deepEqual(facts?.["ciphers-by-protocol"], {
                SSLv2: ["SSL_CK_RC4_128_WITH_MD5"],
                SSLv3: ["TLS_RSA_WITH_RC4_128_SHA", "TLS_RSA_WITH_3DES_EDE_CBC_SHA", "TLS_RSA_WITH_AES_128_CBC_SHA"],
                TLSv1: ["TLS_RSA_EXPORT_WITH_RC4_40_MD5", "TLS_RSA_WITH_RC4_128_SHA", "TLS_RSA_WITH_AES_128_CBC_SHA", "TLS_DHE_RSA_WITH_AES_128_CBC_SHA"],
            });
            assert.deepEqual(facts?.["insecure-ciphers"], ["TLS_RSA_EXPORT_WITH_RC4_40_MD5", "TLS_RSA_WITH_RC4_128_SHA", "SSL_CK_RC4_128_WITH_MD5"]);
            assert.deepEqual(facts?.["weak-ciphers"], ["TLS_RSA_WITH_AES_128_CBC_SHA", "TLS_DHE_RSA_WITH_AES_128_CBC_SHA", "TLS_RSA_WITH_3DES_EDE_CBC_SHA"]);
            assert.deepEqual(facts?.vulnerabilities, ["poodle", "beast", "sweet32", "freak", "rc4", "drown", "crime"]);
            assert.deepEqual([facts?.["server-order"], facts?.["fallback-scsv"], facts?.compression, facts?.["secure-renegotiation"], facts?.["dh-bits"], facts?.["forward-secrecy"]], [false, false, true, false, 1024, "some"]);
            assert.deepEqual(facts?.chain, { sent: 1, complete: true });
            assert.deepEqual(judged(origin, facts), [
                ["tls-probe/compression", "warning"],
                ["tls-probe/fallback-scsv", "info"],
                ["tls-probe/forward-secrecy", "warning"],
                ["tls-probe/insecure-ciphers", "error"],
                ["tls-probe/legacy-protocols", "error"],
                ["tls-probe/secure-renegotiation", "warning"],
                ["tls-probe/server-cipher-order", "info"],
                ["tls-probe/tls13-missing", "info"],
                ["tls-probe/vulnerabilities", "error"],
                ["tls-probe/weak-ciphers", "warning"],
                ["tls-probe/weak-dh", "warning"],
            ]);
        } finally {
            await server.close();
        }
    });

    it("lists protocols but no suites with the scan off", async () => {
        const pem = certificate()?.cert as Buffer;
        const server = await serveScripted({ versions: { 0x03_01: [0x00_2f, 0x00_05], 0x03_03: [0xc0_2f] }, isRenegotiationSecure: true, hasScsv: true, certificate: new X509Certificate(pem).raw });
        try {
            const facts = await probed(`https://localhost:${server.port}`, { scan: false });
            assert.deepEqual(facts, { address: "127.0.0.1", protocols: ["TLSv1", "TLSv1.2"], legacy: ["TLSv1"], "secure-renegotiation": true, heartbeat: false, compression: false, "fallback-scsv": true, chain: { sent: 1, complete: true }, ocsp: { responder: false, stapled: false } });
        } finally {
            await server.close();
        }
    });

    it("reads a TLS 1.3-only server’s suites, groups, chain and stapled OCSP through its encrypted flight", async () => {
        const modern = await serveTls(["http/1.1"], { minVersion: "TLSv1.3" }, OCSP_OK);
        try {
            const facts = await probed(modern?.origin ?? "");
            assert.deepEqual([facts?.protocols, facts?.legacy, facts?.chain, facts?.ocsp, facts?.["early-data"], facts?.["forward-secrecy"]], [["TLSv1.3"], [], { sent: 1, complete: true }, { responder: true, stapled: true }, false, "all"]);
            assert.deepEqual((facts?.ciphers as string[]).toSorted((a, b) => a.localeCompare(b)), ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]);
            assert.ok((facts?.groups as string[]).includes("x25519"));
            assert.equal("server-order" in (facts ?? {}), false);
            assert.deepEqual(judged(modern?.origin ?? "", facts), []);
        } finally {
            await modern?.close();
        }
    });

    it("reads a TLS 1.2 server’s stapled OCSP in the clear and finds the client choosing among weak suites", async () => {
        const classic = await serveTls(["http/1.1"], { maxVersion: "TLSv1.2", honorCipherOrder: false }, OCSP_OK);
        try {
            const facts = await probed(classic?.origin ?? "");
            assert.deepEqual([facts?.protocols, facts?.ocsp, facts?.["server-order"], facts?.["secure-renegotiation"], facts?.vulnerabilities], [["TLSv1.2"], { responder: true, stapled: true }, false, true, []]);
            assert.equal("fallback-scsv" in (facts ?? {}), false);
            assert.deepEqual(judged(classic?.origin ?? "", facts), [["tls-probe/server-cipher-order", "info"], ["tls-probe/tls13-missing", "info"], ["tls-probe/weak-ciphers", "warning"]]);
        } finally {
            await classic?.close();
        }
    });

    it("hands org.spiderlint.tls-probe to the extractor, which keys its cached facts by it", async () => {
        const rules = compileRulesets(["tls-probe"], {});
        await loadPlugins([], { "tls-probe": { scan: false } });
        assert.deepEqual(siteExtractorsFor(rules)[0]?.settings, { scan: false });
        await loadPlugins([], {});
        assert.deepEqual(siteExtractorsFor(rules)[0]?.settings, { scan: true });
        await assert.rejects(loadPlugins([], { "tls-probe": { scan: "no" } }), ConfigError);
        await loadPlugins([], {});
    });

    it("scans on and skips early data with one warning where openssl is not on PATH", async (context) => {
        const modern = await serveTls(["http/1.1"], { minVersion: "TLSv1.3" });
        const warn = context.mock.method(log, "warn");
        const path = process.env.PATH;
        process.env.PATH = "/nonexistent";
        try {
            const [first, second] = [await probed(modern?.origin ?? ""), await probed(modern?.origin ?? "")];
            assert.deepEqual([first?.protocols, "early-data" in (first ?? {}), second?.protocols], [["TLSv1.3"], false, ["TLSv1.3"]]);
        } finally {
            process.env.PATH = path;
            await modern?.close();
        }
        assert.equal(warn.mock.calls.filter((call) => String(call.arguments[1]).includes("openssl not found")).length, 1);
    });
});
