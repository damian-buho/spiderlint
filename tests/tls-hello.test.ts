// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { clientHello, curve, dhBits, openHandshake, readFlight } from "../src/crawl/tls-hello.ts";
import { CLIENT_HELLO, ENCRYPTED_RECORD, HANDSHAKE_PLAINTEXT, SERVER_HELLO, SERVER_HELLO_RECORD, SHARED_SECRET } from "./fixtures/rfc8448.ts";

function hex(text: string): Buffer {
    return Buffer.from(text, "hex");
}

const RETRY = Buffer.from("cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c", "hex");

function u16(value: number): Buffer {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(value);
    return bytes;
}

function u24(value: number): Buffer {
    const bytes = Buffer.alloc(3);
    bytes.writeUIntBE(value, 0, 3);
    return bytes;
}

function message(type: number, body: Buffer): Buffer {
    return Buffer.concat([Buffer.from([type]), u24(body.length), body]);
}

function record(type: number, body: Buffer): Buffer {
    return Buffer.concat([Buffer.from([type, 3, 3]), u16(body.length), body]);
}

// A ServerHello body at `version` choosing `suite`, with `extensions` as type and data pairs.
function serverHello(version: number, suite: number, extensions: [number, Buffer][], random = Buffer.alloc(32, 1)): Buffer {
    const list = Buffer.concat(extensions.map(([type, data]) => Buffer.concat([u16(type), u16(data.length), data])));
    return message(2, Buffer.concat([u16(version), random, Buffer.from([0]), u16(suite), Buffer.from([0]), u16(list.length), list]));
}

describe("TLS hello bytes", () => {
    it("builds a TLS 1.2 hello with SNI, the suites, DEFLATE and renegotiation_info", () => {
        const hello = clientHello({ protocol: "TLSv1.2", suites: [0x00_2f, 0xc0_2b], host: "example.org", groups: [29], compression: true });
        assert.deepEqual([...hello.subarray(0, 3)], [22, 3, 1]);
        assert.equal(hello.readUInt16BE(3), hello.length - 5);
        assert.equal(hello.readUInt16BE(9), 0x03_03);
        assert.deepEqual([hello[43], hello.readUInt16BE(44), hello.readUInt16BE(46), hello.readUInt16BE(48)], [0, 4, 0x00_2f, 0xc0_2b]);
        assert.deepEqual([...hello.subarray(50, 53)], [2, 1, 0]);
        assert.ok(hello.includes(Buffer.from("example.org")));
        assert.ok(hello.includes(Buffer.from([0xff, 0x01, 0, 1, 0])));
    });

    it("pads a hello out of the 256–511 byte range and leaves SSLv3 without extensions", () => {
        const padded = clientHello({ protocol: "TLSv1.2", suites: Array.from({ length: 80 }, (_, index) => index + 1), host: "127.0.0.1", groups: [23] });
        assert.ok(padded.length - 5 >= 512, `${padded.length - 5} bytes`);
        const sslv3 = clientHello({ protocol: "SSLv3", suites: [5, 10], host: "example.org", groups: [23] });
        assert.equal(sslv3.readUInt16BE(1), 0x03_00);
        assert.equal(sslv3.length, 5 + 4 + 2 + 32 + 1 + 2 + 4 + 2);
    });

    it("sends TLS 1.3 as TLS 1.2 with supported_versions, an empty key_share and no compression", () => {
        const hello = clientHello({ protocol: "TLSv1.3", suites: [0x13_01], host: "example.org", groups: [29], shares: [], compression: true });
        assert.equal(hello.readUInt16BE(9), 0x03_03);
        assert.ok(hello.includes(Buffer.from([0, 0x2b, 0, 3, 2, 3, 4])));
        assert.ok(hello.includes(Buffer.from([0, 0x33, 0, 2, 0, 0])));
        assert.ok(!hello.includes(Buffer.from([0xff, 0x01, 0, 1, 0])));
        assert.deepEqual([...hello.subarray(76, 80)], [0, 2, 0x13, 0x01]);
        assert.deepEqual([...hello.subarray(80, 82)], [1, 0]);
    });
});

describe("TLS flights", () => {
    it("reads a TLS 1.2 flight split across records, and waits while it is incomplete", () => {
        const hello = serverHello(0x03_03, 0xc0_2f, [[0xff_01, hex("00")]]);
        const stream = Buffer.concat([hello, message(11, hex("000006000003616263")), message(22, hex("010000023000")), message(12, hex("0300170104")), message(14, hex(""))]);
        const data = Buffer.concat([record(22, stream.subarray(0, 30)), record(22, stream.subarray(30))]);
        assert.deepEqual(readFlight(data.subarray(0, 40)), { complete: false });
        const flight = readFlight(data);
        assert.deepEqual({ ...flight, keyExchange: undefined }, { complete: true, version: 0x03_03, suite: 0xc0_2f, compression: 0, extensions: [0xff_01], certificates: [Buffer.from("abc")], ocsp: Buffer.from([0x30, 0]), keyExchange: undefined });
        assert.equal(curve(flight.keyExchange as Buffer), 23);
    });

    it("reads an alert, a HelloRetryRequest and an SSLv2 SERVER-HELLO", () => {
        assert.deepEqual(readFlight(Buffer.from([21, 3, 3, 0, 2, 2, 40])), { complete: true, alert: 40 });
        const hello = serverHello(
            0x03_03,
            0x13_02,
            [
                [43, hex("0304")],
                [51, hex("0017")],
            ],
            RETRY,
        );
        const retry = readFlight(record(22, hello));
        assert.deepEqual(retry, { complete: true, version: 0x03_04, retry: true, suite: 0x13_02, compression: 0, extensions: [43, 51], group: 23 });
        const sslv2 = hex(`80210400010002000300030010616263010080${"00".repeat(16)}`);
        assert.deepEqual(readFlight(sslv2), { complete: true, version: 2, certificates: [Buffer.from("abc")], kinds: [0x01_00_80] });
    });

    it("decrypts the RFC 8448 server flight up to its Certificate", () => {
        const transcript = Buffer.concat([CLIENT_HELLO, SERVER_HELLO]);
        const open = openHandshake(SHARED_SECRET, transcript);
        const inner = open(ENCRYPTED_RECORD.subarray(0, 5), ENCRYPTED_RECORD.subarray(5));
        assert.ok(inner.subarray(0, HANDSHAKE_PLAINTEXT.length).equals(HANDSHAKE_PLAINTEXT));
        assert.equal(inner[HANDSHAKE_PLAINTEXT.length], 22);
        const data = Buffer.concat([SERVER_HELLO_RECORD, ENCRYPTED_RECORD]);
        const flight = readFlight(data, { hello: CLIENT_HELLO, agree: () => SHARED_SECRET });
        assert.deepEqual([flight.complete, flight.version, flight.suite, flight.group, flight.error], [true, 0x03_04, 0x13_01, 29, undefined]);
        assert.equal(new X509Certificate(flight.certificates?.[0] as Buffer).subject, "CN=rsa");
    });

    it("stops at a TLS 1.3 ServerHello it holds no key for, and reports bytes it cannot read", () => {
        assert.deepEqual(readFlight(SERVER_HELLO_RECORD).complete, true);
        const broken = record(22, message(2, hex("0303")));
        assert.match(readFlight(broken).error ?? "", /range/i);
    });

    it("measures a DHE prime and names an ECDHE curve", () => {
        const [short, full] = [hex(`00807f${"ff".repeat(127)}`), hex(`0100${"ff".repeat(256)}`)];
        assert.deepEqual([dhBits(short), dhBits(full)], [1023, 2048]);
        assert.equal(curve(hex("03001d")), 29);
        assert.equal(curve(hex("01001d")), undefined);
    });
});
