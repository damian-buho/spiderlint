// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { cookieFacts, redactHeaders, timingFacts, tlsFacts } from "../src/facts/transport.ts";
import { compileRule } from "../src/rules/declarative.ts";
import { resolveRuleset } from "../src/rules/rulesets.ts";
import type { Facts } from "../src/facts/types.ts";
import type { PageRule } from "../src/rules/types.ts";
import { certificate } from "./fixtures/tls.ts";

// The TLS facts of a socket presenting one self-signed certificate made with `key` options; undefined without `openssl`.
function selfSigned(key: string[]): ReturnType<typeof tlsFacts> {
    const pair = certificate(false, key);
    if (!pair) return undefined;
    const peer: Record<string, unknown> = { subject: { CN: "localhost" }, raw: new X509Certificate(pair.cert).raw };
    peer.issuerCertificate = peer;
    return tlsFacts({ getPeerCertificate: () => peer, getProtocol: () => "TLSv1.3", getCipher: () => ({}), authorized: true } as unknown as TLSSocket);
}

// The key and signature rules' findings on an https: page carrying `tls`.
function tlsFindings(tls: ReturnType<typeof tlsFacts>): string[] {
    const specs = resolveRuleset("spiderlint:tls", {});
    const page = { url: { href: "https://localhost/", protocol: "https:" }, tls } as unknown as Facts;
    return ["tls/key-strength", "tls/signature"].flatMap((id) => (compileRule(id, specs[id] ?? {}) as PageRule).check(page, { sitemaps: [], role: "production" }) ?? []).map((finding) => finding.rule);
}

describe("transport facts", () => {
    it("reads every cookie's flags", () => {
        assert.deepEqual(cookieFacts(["a=1; Secure; HttpOnly; SameSite=Strict", "b=2"]), [
            { name: "a", secure: true, "http-only": true, "same-site": "Strict" },
            { name: "b", secure: false, "http-only": false },
        ]);
    });

    it("redacts credentials and cookie values, keeping cookie attributes", () => {
        assert.deepEqual(redactHeaders({ authorization: "Bearer x", "set-cookie": ["a=1; Secure"], server: "nginx" }), { authorization: "[redacted]", "set-cookie": ["a=[redacted]; Secure"], server: "nginx" });
    });

    it("drops HTTP/2 pseudo-headers, as a revalidating 304 carries them", () => {
        assert.deepEqual(redactHeaders({ ":status": "304", etag: '"a"' }), { etag: '"a"' });
    });

    it("renames got's phases and drops the skipped ones", () => {
        assert.deepEqual(timingFacts({ timings: { phases: { wait: 1, dns: undefined, firstByte: 5, total: 9 } } }), { wait: 1, ttfb: 5, total: 9 });
    });

    it("reads the certificate off a TLS socket, and nothing off a plain one", () => {
        const socket = {
            getPeerCertificate: () => ({ subject: { CN: "a.test" }, issuer: { O: "CA" }, valid_from: "Jan  1 00:00:00 2026 GMT", valid_to: "Jan 11 00:00:00 2026 GMT", subjectaltname: "DNS:a.test, DNS:b.test", fingerprint256: "AB:CD" }),
            getProtocol: () => "TLSv1.3",
            getCipher: () => ({ name: "TLS_AES_128_GCM_SHA256" }),
            alpnProtocol: "h2",
            authorized: false,
            authorizationError: "CERT_HAS_EXPIRED",
        } as unknown as TLSSocket;
        const facts = tlsFacts(socket, Date.parse("2026-01-01T00:00:00Z"));
        assert.equal(facts?.error, "CERT_HAS_EXPIRED");
        assert.equal(facts?.cert["days-left"], 10);
        assert.deepEqual(facts?.cert.san, ["a.test", "b.test"]);
        assert.equal(facts?.cert.issuer, "CA");
        assert.equal(tlsFacts(undefined), undefined);
    });

    it("reads the key and chain signatures of a real certificate, and judges them", (t) => {
        const strong = selfSigned(["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]);
        if (!strong) return t.skip("openssl is not on PATH");
        assert.deepEqual(strong.cert.key, { type: "EC", curve: "P-256" });
        assert.deepEqual(strong.cert.signatures, ["ecdsa-with-SHA256"]);
        assert.deepEqual(tlsFindings(strong), []);
        const small = selfSigned(["-newkey", "rsa:1024"]);
        assert.deepEqual(small?.cert.key, { type: "RSA", bits: 1024 });
        assert.deepEqual(tlsFindings(small), ["tls/key-strength"]);
        assert.deepEqual(tlsFindings(selfSigned(["-newkey", "rsa:2048", "-sha1"])), ["tls/signature"]);
    });
});
