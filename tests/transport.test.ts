// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TLSSocket } from "node:tls";
import { cookieFacts, redactHeaders, timingFacts, tlsFacts } from "../src/facts/transport.ts";

describe("transport facts", () => {
    it("reads every cookie's flags", () => {
        assert.deepEqual(cookieFacts(["a=1; Secure; HttpOnly; SameSite=Strict", "b=2"]), [
            { name: "a", secure: true, httpOnly: true, sameSite: "Strict" },
            { name: "b", secure: false, httpOnly: false },
        ]);
    });

    it("redacts credentials and cookie values", () => {
        assert.deepEqual(redactHeaders({ authorization: "Bearer x", "set-cookie": ["a=1; Secure"], server: "nginx" }), { authorization: "[redacted]", "set-cookie": ["a=[redacted]"], server: "nginx" });
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
        assert.equal(facts?.cert.daysLeft, 10);
        assert.deepEqual(facts?.cert.san, ["a.test", "b.test"]);
        assert.equal(facts?.cert.issuer, "CA");
        assert.equal(tlsFacts(undefined), undefined);
    });
});
