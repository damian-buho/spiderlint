// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { type AddressInfo, createServer, type Socket } from "node:net";
import { SUITES } from "../../src/plugins/tls-registry.ts";

// How a scripted server answers: what Node’s TLS cannot serve, such as SSLv2, SSLv3, RC4 and export suites.
export interface Script {
    // Suites each wire version accepts, in the server’s order.
    versions: Record<number, number[]>;
    // SSLv2 cipher kinds; none refuses SSLv2.
    kinds?: number[];
    isServerOrder?: boolean;
    isCompressing?: boolean;
    isRenegotiationSecure?: boolean;
    hasScsv?: boolean;
    // Bits of the DHE prime it sends.
    dhBits?: number;
    certificate: Buffer;
}

export interface Scripted {
    port: number;
    close(): Promise<void>;
}

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

// One handshake message of `type` in a record at `version`.
function handshake(version: number, type: number, body: Buffer): Buffer {
    const message = Buffer.concat([Buffer.from([type]), u24(body.length), body]);
    return Buffer.concat([Buffer.from([22]), u16(version), u16(message.length), message]);
}

function alert(description: number): Buffer {
    return Buffer.from([21, 3, 1, 0, 2, 2, description]);
}

// The version, suites, compression methods and extension types of a ClientHello record.
function parseHello(data: Buffer): { version: number; suites: number[]; methods: number[]; extensions: number[] } {
    const body = data.subarray(9);
    let at = 35 + (body[34] ?? 0);
    const suites = Array.from({ length: body.readUInt16BE(at) / 2 }, (_, index) => body.readUInt16BE(at + 2 + index * 2));
    at += 2 + suites.length * 2;
    const methods = [...body.subarray(at + 1, at + 1 + (body[at] ?? 0))];
    at += 1 + methods.length;
    const extensions: number[] = [];
    for (let entry = at + 2; entry + 4 <= body.length; entry += 4 + body.readUInt16BE(entry + 2)) extensions.push(body.readUInt16BE(entry));
    return { version: body.readUInt16BE(0), suites, methods, extensions };
}

// The whole answer to one ClientHello: an alert, or ServerHello through ServerHelloDone.
function answer(script: Script, data: Buffer): Buffer {
    const hello = parseHello(data);
    const best = Math.max(...Object.keys(script.versions).map(Number));
    const version = Math.min(hello.version, best);
    const accepted = script.versions[version];
    if (!accepted) return alert(70);
    if (script.hasScsv && hello.suites.includes(0x56_00) && hello.version < best) return alert(86);
    const suite = script.isServerOrder ? accepted.find((code) => hello.suites.includes(code)) : hello.suites.find((code) => accepted.includes(code));
    if (suite === undefined) return alert(40);
    const isCompressed = Boolean(script.isCompressing) && hello.methods.includes(1);
    const renegotiation = script.isRenegotiationSecure && hello.extensions.includes(0xff_01) ? Buffer.from([0xff, 0x01, 0, 1, 0]) : Buffer.alloc(0);
    const serverHello = Buffer.concat([u16(version), Buffer.alloc(32, 7), Buffer.from([0]), u16(suite), Buffer.from([isCompressed ? 1 : 0]), ...(renegotiation.length > 0 ? [u16(renegotiation.length), renegotiation] : [])]);
    const certificate = Buffer.concat([u24(script.certificate.length + 3), u24(script.certificate.length), script.certificate]);
    const name = SUITES[suite] ?? "";
    const prime = Buffer.alloc((script.dhBits ?? 2048) / 8, 0xff);
    const keyExchange = name.startsWith("TLS_DHE_") ? Buffer.concat([u16(prime.length), prime, u16(1), Buffer.from([2]), u16(prime.length), prime, u16(2), Buffer.from([0, 0])]) : name.startsWith("TLS_ECDHE_") ? Buffer.from([3, 0, 23, 1, 4, 0, 2, 0, 0]) : undefined;
    return Buffer.concat([handshake(version, 2, serverHello), handshake(version, 11, certificate), ...(keyExchange ? [handshake(version, 12, keyExchange)] : []), handshake(version, 14, Buffer.alloc(0))]);
}

// An SSLv2 SERVER-HELLO offering `kinds`.
function sslv2Answer(script: Script, kinds: number[]): Buffer {
    const list = Buffer.concat(kinds.map((kind) => u24(kind)));
    const body = Buffer.concat([Buffer.from([4, 0, 1]), u16(2), u16(script.certificate.length), u16(list.length), u16(16), script.certificate, list, Buffer.alloc(16, 9)]);
    return Buffer.concat([u16(0x80_00 | body.length), body]);
}

// Answers each connection’s first hello as `script` says, then closes it.
export async function serveScripted(script: Script): Promise<Scripted> {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        let data = Buffer.alloc(0);
        socket.on("error", () => socket.destroy());
        socket.on("data", (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
            const isSsl2 = ((data[0] ?? 0) & 0x80) !== 0;
            const length = isSsl2 ? ((data[0] ?? 0) & 0x7f) * 256 + (data[1] ?? 0) + 2 : data.length >= 5 ? data.readUInt16BE(3) + 5 : Infinity;
            if (data.length < length) return;
            if (isSsl2 && !script.kinds) socket.destroy();
            else socket.end(isSsl2 ? sslv2Answer(script, script.kinds ?? []) : answer(script, data));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as AddressInfo).port,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
                for (const socket of sockets) socket.destroy();
            }),
    };
}
