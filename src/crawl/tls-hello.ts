// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createDecipheriv, createECDH, createHash, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from "node:crypto";
import { isIP } from "node:net";

// Wire versions by Node’s protocol name.
export const VERSIONS = { SSLv3: 0x03_00, TLSv1: 0x03_01, "TLSv1.1": 0x03_02, "TLSv1.2": 0x03_03, "TLSv1.3": 0x03_04 } as const;

export type Protocol = "SSLv2" | keyof typeof VERSIONS;

// The suite a client adds when it retries at a lower version (RFC 7507).
export const FALLBACK_SCSV = 0x56_00;

// The alert a server supporting RFC 7507 answers a needless fallback with.
export const INAPPROPRIATE_FALLBACK = 86;

// The one TLS 1.3 suite every server implements (RFC 8446 §9.1), which `openHandshake` decrypts.
export const TLS13_MANDATORY = 0x13_01;

// SSLv2 cipher kinds, by the name OpenSSL gives them.
export const SSL2_KINDS: Record<number, string> = {
    0x01_00_80: "SSL_CK_RC4_128_WITH_MD5",
    0x02_00_80: "SSL_CK_RC4_128_EXPORT40_WITH_MD5",
    0x03_00_80: "SSL_CK_RC2_128_CBC_WITH_MD5",
    0x04_00_80: "SSL_CK_RC2_128_CBC_EXPORT40_WITH_MD5",
    0x05_00_80: "SSL_CK_IDEA_128_CBC_WITH_MD5",
    0x06_00_40: "SSL_CK_DES_64_CBC_WITH_MD5",
    0x07_00_c0: "SSL_CK_DES_192_EDE3_CBC_WITH_MD5",
};

const HANDSHAKE = 22;
const ALERT = 21;
const APPLICATION = 23;
const X25519 = 29;
const SECP256R1 = 23;
// The ServerHello random that marks a HelloRetryRequest (RFC 8446 §4.1.3).
const RETRY = Buffer.from("cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c", "hex");
// The DER prefix turning a raw x25519 key into a SubjectPublicKeyInfo.
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
// Every signature scheme a server may sign with, so none refuses for want of one.
const SIGNATURES = [0x04_03, 0x05_03, 0x06_03, 0x08_07, 0x08_08, 0x08_04, 0x08_05, 0x08_06, 0x08_09, 0x08_0a, 0x08_0b, 0x08_1a, 0x08_1b, 0x08_1c, 0x04_01, 0x05_01, 0x06_01, 0x03_03, 0x03_01, 0x04_02, 0x05_02, 0x06_02, 0x02_03, 0x02_01, 0x02_02];

export interface Hello {
    // `TLSv1.3` goes out as TLS 1.2 with `supported_versions`.
    protocol: Exclude<Protocol, "SSLv2">;
    suites: number[];
    // The SNI name; an IP literal sends none.
    host: string;
    groups: number[];
    // TLS 1.3 key shares; none asks the server to name its group in a HelloRetryRequest.
    shares?: KeyShare[];
    // Offers DEFLATE before null, which only a CRIME-prone server takes.
    compression?: true;
}

export interface KeyShare {
    group: number;
    key: Buffer;
}

// What the server sent before the client has to speak again.
export interface Flight {
    // Whether the server said all it will: an alert, `ServerHelloDone`, a HelloRetryRequest or a TLS 1.3 `Certificate`.
    complete: boolean;
    alert?: number;
    // The version chosen, `supported_versions` over the legacy field.
    version?: number;
    suite?: number;
    compression?: number;
    // Extension types the ServerHello carries.
    extensions?: number[];
    retry?: true;
    // The group a HelloRetryRequest or a TLS 1.3 key share names.
    group?: number;
    share?: Buffer;
    // DER certificates, leaf first.
    certificates?: Buffer[];
    ocsp?: Buffer;
    // The ServerKeyExchange body, read by `dhBits` and `curve`.
    keyExchange?: Buffer;
    // SSLv2 cipher kinds the server offers.
    kinds?: number[];
    // Why the bytes could not be read.
    error?: string;
}

// Key pairs behind a TLS 1.3 hello, and the ClientHello message its transcript starts with.
export interface Client {
    hello: Buffer;
    agree(group: number, share: Buffer): Buffer | undefined;
}

function u8(value: number): Buffer {
    return Buffer.from([value]);
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

// `body` behind its length in `width` bytes.
function vector(width: 1 | 2 | 3, body: Buffer): Buffer {
    return Buffer.concat([[u8, u16, u24][width - 1]?.(body.length) ?? Buffer.alloc(0), body]);
}

function extension(type: number, body: Buffer): Buffer {
    return Buffer.concat([u16(type), vector(2, body)]);
}

// A vector of 16-bit values.
function list16(values: number[]): Buffer {
    return vector(2, Buffer.concat(values.map((value) => u16(value))));
}

// The `server_name` body naming `host`.
function serverName(host: string): Buffer {
    const name = vector(2, Buffer.from(host));
    return vector(2, Buffer.concat([u8(0), name]));
}

// The `key_share` body carrying `shares`.
function keyShareList(shares: KeyShare[]): Buffer {
    const entries = shares.map((share) => Buffer.concat([u16(share.group), vector(2, share.key)]));
    return vector(2, Buffer.concat(entries));
}

// The extensions of a hello; SSLv3 sends none, TLS 1.3 swaps renegotiation and heartbeat for versions and key shares.
function extensionsOf(hello: Hello, version: number): Buffer[] {
    if (version === VERSIONS.SSLv3) return [];
    const isModern = version === VERSIONS["TLSv1.3"];
    return [
        ...(isIP(hello.host) === 0 ? [extension(0, serverName(hello.host))] : []),
        extension(5, Buffer.from([1, 0, 0, 0, 0])),
        extension(10, list16(hello.groups)),
        extension(11, Buffer.from([1, 0])),
        ...(version >= VERSIONS["TLSv1.2"] ? [extension(13, list16(SIGNATURES))] : []),
        ...(isModern ? [extension(43, Buffer.from([2, 3, 4])), extension(51, keyShareList(hello.shares ?? []))] : [extension(15, u8(1)), extension(0xff_01, u8(0))]),
    ];
}

// One ClientHello record, padded out of the 256–511 byte range some load balancers drop (RFC 7685).
export function clientHello(hello: Hello): Buffer {
    const version = VERSIONS[hello.protocol];
    const isModern = version === VERSIONS["TLSv1.3"];
    const session = vector(1, isModern ? randomBytes(32) : Buffer.alloc(0));
    const compression = vector(1, Buffer.from(!isModern && hello.compression ? [1, 0] : [0]));
    const head = Buffer.concat([u16(Math.min(version, VERSIONS["TLSv1.2"])), randomBytes(32), session, list16(hello.suites), compression]);
    const extensions = extensionsOf(hello, version);
    const length = 4 + head.length + 2 + extensions.reduce((sum, entry) => sum + entry.length, 0);
    const padding = Buffer.alloc(Math.max(0, 512 - length - 4));
    if (version !== VERSIONS.SSLv3 && length >= 256 && length < 512) extensions.push(extension(21, padding));
    const body = version === VERSIONS.SSLv3 ? head : Buffer.concat([head, vector(2, Buffer.concat(extensions))]);
    const message = Buffer.concat([u8(1), vector(3, body)]);
    return Buffer.concat([u8(HANDSHAKE), u16(Math.min(version, VERSIONS.TLSv1)), vector(2, message)]);
}

// An SSLv2 CLIENT-HELLO offering every cipher kind.
export function sslv2Hello(): Buffer {
    const kinds = Buffer.concat(Object.keys(SSL2_KINDS).map((kind) => u24(Number(kind))));
    const body = Buffer.concat([u8(1), u16(0x00_02), u16(kinds.length), u16(0), u16(16), kinds, randomBytes(16)]);
    return Buffer.concat([u16(0x80_00 | body.length), body]);
}

// Fresh x25519 and secp256r1 key shares, and the TLS 1.3 client that can decrypt the answer to the hello carrying them.
export function keyShares(): { shares: KeyShare[]; client(hello: Buffer): Client } {
    const x25519 = generateKeyPairSync("x25519");
    const p256 = createECDH("prime256v1");
    p256.generateKeys();
    const shares = [
        { group: X25519, key: x25519.publicKey.export({ format: "der", type: "spki" }).subarray(-32) },
        { group: SECP256R1, key: p256.getPublicKey() },
    ];
    const agree = (group: number, share: Buffer) => {
        if (group === SECP256R1) return p256.computeSecret(share);
        if (group !== X25519) return;
        const publicKey = createPublicKey({ key: Buffer.concat([X25519_SPKI, share]), format: "der", type: "spki" });
        return diffieHellman({ privateKey: x25519.privateKey, publicKey });
    };
    return { shares, client: (hello) => ({ hello: hello.subarray(5), agree }) };
}

function sha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

function hmac(key: Buffer, data: Buffer): Buffer {
    return createHmac("sha256", key).update(data).digest();
}

// HKDF-Expand-Label over SHA-256 (RFC 8446 §7.1).
function expandLabel(secret: Buffer, label: string, context: Buffer, length: number): Buffer {
    const name = Buffer.from(`tls13 ${label}`);
    const info = Buffer.concat([u16(length), vector(1, name), vector(1, context)]);
    const blocks: Buffer[] = [];
    for (let block: Buffer = Buffer.alloc(0), index = 1; blocks.length * 32 < length; index++) {
        block = hmac(secret, Buffer.concat([block, info, u8(index)]));
        blocks.push(block);
    }
    return Buffer.concat(blocks).subarray(0, length);
}

// The server handshake traffic decrypter of TLS_AES_128_GCM_SHA256, from the shared secret and the ClientHello…ServerHello transcript.
export function openHandshake(secret: Buffer, transcript: Buffer): (header: Buffer, sealed: Buffer) => Buffer {
    const empty = Buffer.alloc(0);
    const early = hmac(Buffer.alloc(32), Buffer.alloc(32));
    const handshake = hmac(expandLabel(early, "derived", sha256(empty), 32), secret);
    const traffic = expandLabel(handshake, "s hs traffic", sha256(transcript), 32);
    const [key, iv] = [expandLabel(traffic, "key", empty, 16), expandLabel(traffic, "iv", empty, 12)];
    let sequence = 0n;
    return (header, sealed) => {
        const nonce = Buffer.from(iv);
        nonce.writeBigUInt64BE(nonce.readBigUInt64BE(4) ^ sequence++, 4);
        const decipher = createDecipheriv("aes-128-gcm", key, nonce);
        decipher.setAAD(header);
        decipher.setAuthTag(sealed.subarray(-16));
        return Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    };
}

// The ServerHello’s version, suite, compression and extensions into `flight`.
function readServerHello(body: Buffer, flight: Flight): void {
    flight.version = body.readUInt16BE(0);
    if (body.subarray(2, 34).equals(RETRY)) flight.retry = true;
    let at = 35 + (body[34] ?? 0);
    flight.suite = body.readUInt16BE(at);
    flight.compression = body[at + 2];
    at += 3;
    flight.extensions = [];
    const end = at + 2 <= body.length ? at + 2 + body.readUInt16BE(at) : at;
    for (at += 2; at + 4 <= end; at += 4 + body.readUInt16BE(at + 2)) {
        const type = body.readUInt16BE(at);
        const data = body.subarray(at + 4, at + 4 + body.readUInt16BE(at + 2));
        flight.extensions.push(type);
        if (type === 43) flight.version = data.readUInt16BE(0);
        else if (type === 51) flight.group = data.readUInt16BE(0);
        if (type === 51 && !flight.retry) flight.share = data.subarray(4, 4 + data.readUInt16BE(2));
    }
}

// The OCSP response of a CertificateStatus body, when it carries one.
function readStatus(body: Buffer): Buffer | undefined {
    return body[0] === 1 ? body.subarray(4, 4 + body.readUIntBE(1, 3)) : undefined;
}

// The certificates of a Certificate message, and in TLS 1.3 the leaf’s stapled OCSP response.
function readCertificates(body: Buffer, flight: Flight): void {
    const isModern = flight.version === VERSIONS["TLSv1.3"];
    let at = isModern ? 1 + (body[0] ?? 0) : 0;
    const end = at + 3 + body.readUIntBE(at, 3);
    const certificates: Buffer[] = [];
    for (at += 3; at + 3 <= end;) {
        const size = body.readUIntBE(at, 3);
        certificates.push(body.subarray(at + 3, at + 3 + size));
        at += 3 + size;
        if (!isModern) continue;
        const extensionsEnd = at + 2 + body.readUInt16BE(at);
        for (let entry = at + 2; entry + 4 <= extensionsEnd; entry += 4 + body.readUInt16BE(entry + 2)) {
            const data = body.subarray(entry + 4, entry + 4 + body.readUInt16BE(entry + 2));
            if (certificates.length === 1 && body.readUInt16BE(entry) === 5) flight.ocsp = readStatus(data);
        }
        at = extensionsEnd;
    }
    flight.certificates = certificates;
}

// An SSLv2 SERVER-HELLO: its certificate and the cipher kinds it offers.
function readSsl2(data: Buffer): Flight {
    const length = ((data[0] ?? 0) & 0x7f) * 256 + (data[1] ?? 0);
    if (data.length < 2 + length) return { complete: false };
    const body = data.subarray(2, 2 + length);
    const [certificate, kinds] = [body.readUInt16BE(5), body.readUInt16BE(7)];
    const list = body.subarray(11 + certificate, 11 + certificate + kinds);
    const offered = Array.from({ length: Math.floor(list.length / 3) }, (_, index) => list.readUIntBE(index * 3, 3));
    return { complete: true, version: 0x00_02, certificates: [body.subarray(11, 11 + certificate)], kinds: offered };
}

// One handshake message into `flight`.
function readMessage(type: number, body: Buffer, flight: Flight): void {
    switch (type) {
        case 2: {
            readServerHello(body, flight);
            break;
        }
        case 11: {
            readCertificates(body, flight);
            break;
        }
        case 12: {
            flight.keyExchange = body;
            break;
        }
        case 22: {
            flight.ocsp = readStatus(body);
            break;
        }
    }
}

// Whether a message of `type` ends what the server says before the client speaks.
function isLast(type: number, flight: Flight): boolean {
    return type === 14 || (type === 2 && flight.retry === true) || (type === 11 && flight.version === VERSIONS["TLSv1.3"]);
}

// The server’s answer so far, read afresh from every byte received; `client` decrypts a TLS 1.3 flight up to its Certificate.
export function readFlight(data: Buffer, client?: Client): Flight {
    if (data.length >= 3 && ((data[0] ?? 0) & 0x80) !== 0 && data[2] === 4) return readSsl2(data);
    const flight: Flight = { complete: false };
    let open: ReturnType<typeof openHandshake> | undefined;
    let stream = Buffer.alloc(0);
    let at = 0;
    try {
        for (let offset = 0; offset + 5 <= data.length;) {
            const header = data.subarray(offset, offset + 5);
            const body = data.subarray(offset + 5, offset + 5 + header.readUInt16BE(3));
            if (body.length < header.readUInt16BE(3)) break;
            offset += 5 + body.length;
            let [type, content] = [header[0], body];
            if (type === APPLICATION && open) {
                const inner = open(header, body);
                const end = inner.findLastIndex((byte) => byte !== 0);
                [type, content] = [inner[end], inner.subarray(0, end)];
            }
            if (type === ALERT) return { ...flight, complete: true, alert: content[1] };
            if (type !== HANDSHAKE) continue;
            stream = Buffer.concat([stream, content]);
            for (; at + 4 <= stream.length && at + 4 + stream.readUIntBE(at + 1, 3) <= stream.length; at += 4 + stream.readUIntBE(at + 1, 3)) {
                const message = stream.subarray(at, at + 4 + stream.readUIntBE(at + 1, 3));
                readMessage(message[0] ?? 0, message.subarray(4), flight);
                if (isLast(message[0] ?? 0, flight)) return { ...flight, complete: true };
                if (message[0] !== 2 || flight.version !== VERSIONS["TLSv1.3"]) continue;
                const secret = client && flight.suite === TLS13_MANDATORY && flight.share && flight.group !== undefined ? client.agree(flight.group, flight.share) : undefined;
                if (!secret || !client) return { ...flight, complete: true };
                open = openHandshake(secret, Buffer.concat([client.hello, message]));
            }
        }
    } catch (error) {
        return { ...flight, complete: true, error: error instanceof Error ? error.message : String(error) };
    }
    return flight;
}

// The prime size of a DHE ServerKeyExchange, in bits.
export function dhBits(keyExchange: Buffer): number {
    const prime = keyExchange.subarray(2, 2 + keyExchange.readUInt16BE(0));
    const first = prime.findIndex((byte) => byte !== 0);
    return first === -1 ? 0 : (prime.length - first) * 8 - Math.clz32(prime[first] ?? 0) + 24;
}

// The named curve of an ECDHE ServerKeyExchange.
export function curve(keyExchange: Buffer): number | undefined {
    return keyExchange[0] === 3 ? keyExchange.readUInt16BE(1) : undefined;
}
