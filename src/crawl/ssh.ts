// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash, createPublicKey, decapsulate, diffieHellman, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { Socket } from "node:net";
import { log } from "../logger.ts";

// RFC 4253 §6.1: the largest packet an implementation must accept.
const MAX_PACKET = 35_000;
const IDENTIFICATION = "SSH-2.0-spiderlint";
// draft-ietf-sshm-mlkem-hybrid-kex-10: ML-KEM-768 and X25519, each half concatenated in that order.
export const HYBRID = "mlkem768x25519-sha256";
const KEX = [HYBRID, "curve25519-sha256", "curve25519-sha256@libssh.org"];
// ML-KEM-768 ciphertext bytes, FIPS 203 table 3.
export const MLKEM_CIPHERTEXT = 1088;
const CIPHERS = ["chacha20-poly1305@openssh.com", "aes128-gcm@openssh.com", "aes256-gcm@openssh.com", "aes128-ctr", "aes256-ctr"];
const MACS = ["hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com", "hmac-sha2-256", "hmac-sha2-512"];
// Host key algorithms whose signature this client verifies, in preference order.
export const HOST_KEY_ALGORITHMS = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "rsa-sha2-512", "rsa-sha2-256", "ssh-ed448"];
const MSG = { disconnect: 1, ignore: 2, debug: 4, kexinit: 20, kexInit: 30, kexReply: 31 } as const;
const CURVES: Record<string, { crv: string; hash: string; size: number }> = {
    nistp256: { crv: "P-256", hash: "sha256", size: 32 },
    nistp384: { crv: "P-384", hash: "sha384", size: 48 },
    nistp521: { crv: "P-521", hash: "sha512", size: 66 },
};

export interface HostKey {
    // The server’s identification line, without CR LF.
    banner: string;
    // Every host key algorithm its KEXINIT lists.
    offered: string[];
    // The RFC 4253 §6.6 public key blob it signed the exchange with; absent when it offers none of the algorithms asked for.
    blob?: Buffer;
}

// An RFC 4251 §5 `string`.
export function sshString(value: Buffer | string): Buffer {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
}

// An RFC 4251 §5 `mpint` of an unsigned big-endian magnitude.
export function mpint(magnitude: Buffer): Buffer {
    const start = magnitude.findIndex((byte) => byte !== 0);
    const trimmed = start === -1 ? Buffer.alloc(0) : magnitude.subarray(start);
    return sshString((trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

// An unencrypted RFC 4253 §6 binary packet, padded to 8-byte blocks.
export function packet(payload: Buffer): Buffer {
    const short = 8 - ((5 + payload.length) % 8);
    const padding = short < 4 ? short + 8 : short;
    const head = Buffer.alloc(5);
    head.writeUInt32BE(1 + payload.length + padding);
    head.writeUInt8(padding, 4);
    return Buffer.concat([head, payload, randomBytes(padding)]);
}

// A KEXINIT payload offering `kex` and `hostKeys`, every other list fixed.
export function kexinit(kex: string[], hostKeys: string[]): Buffer {
    const lists = [kex, hostKeys, CIPHERS, CIPHERS, MACS, MACS, ["none"], ["none"], [], []];
    return Buffer.concat([Buffer.from([MSG.kexinit]), randomBytes(16), ...lists.map((list) => sshString(list.join(","))), Buffer.alloc(5)]);
}

// Reads RFC 4251 §5 fields off a payload, in order.
export class Fields {
    #offset: number;
    readonly #data: Buffer;

    constructor(data: Buffer, offset = 0) {
        this.#data = data;
        this.#offset = offset;
    }

    byte(): number {
        if (this.#offset >= this.#data.length) throw new Error("SSH field past the end of its packet");
        return this.#data.readUInt8(this.#offset++);
    }

    bytes(): Buffer {
        if (this.#offset + 4 > this.#data.length) throw new Error("SSH field past the end of its packet");
        const length = this.#data.readUInt32BE(this.#offset);
        const end = this.#offset + 4 + length;
        if (end > this.#data.length) throw new Error("SSH field past the end of its packet");
        const value = this.#data.subarray(this.#offset + 4, end);
        this.#offset = end;
        return value;
    }

    text(): string {
        return this.bytes().toString("latin1");
    }

    list(): string[] {
        return this.text().split(",").filter(Boolean);
    }
}

// The kex and host key name-lists of a KEXINIT payload.
export function kexinitLists(payload: Buffer): { kex: string[]; hostKeys: string[] } {
    const fields = new Fields(payload, 17);
    return { kex: fields.list(), hostKeys: fields.list() };
}

// The exchange hash of RFC 8731 §3.1 and the hybrid draft §2.5, `secret` already encoded as its method wants.
export function exchangeHash(parts: { client: string; server: string; clientInit: Buffer; serverInit: Buffer; blob: Buffer; clientShare: Buffer; serverShare: Buffer; secret: Buffer }): Buffer {
    const fields = [sshString(parts.client), sshString(parts.server), sshString(parts.clientInit), sshString(parts.serverInit), sshString(parts.blob), sshString(parts.clientShare), sshString(parts.serverShare), parts.secret];
    return createHash("sha256").update(Buffer.concat(fields)).digest();
}

// The hybrid shared secret K, SHA-256 of the ML-KEM secret then the X25519 one, encoded as a string.
export function hybridSecret(quantum: Buffer, classic: Buffer): Buffer {
    return sshString(createHash("sha256").update(Buffer.concat([quantum, classic])).digest());
}

// The client share of `kex` and how the server’s share becomes the encoded shared secret K.
function keyShare(kex: string): { share: Buffer; secret(reply: Buffer): Buffer } {
    const classic = x25519();
    if (kex !== HYBRID) return { share: classic.raw, secret: (reply) => mpint(sharedSecret(classic.privateKey, reply)) };
    const { privateKey, publicKey } = generateKeyPairSync("ml-kem-768");
    const encapsulation = Buffer.from((publicKey.export({ format: "jwk" }) as { pub: string }).pub, "base64url");
    return {
        share: Buffer.concat([encapsulation, classic.raw]),
        secret: (reply) => {
            if (reply.length !== MLKEM_CIPHERTEXT + 32) throw new Error(`SSH hybrid reply is ${reply.length} bytes, not ${MLKEM_CIPHERTEXT + 32}`);
            return hybridSecret(decapsulate(privateKey, reply.subarray(0, MLKEM_CIPHERTEXT)), sharedSecret(classic.privateKey, reply.subarray(MLKEM_CIPHERTEXT)));
        },
    };
}

// A fresh X25519 key pair and its raw 32-byte public half.
export function x25519(): { privateKey: KeyObject; raw: Buffer } {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    return { privateKey, raw: Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url") };
}

// The X25519 shared secret with a peer’s raw public key; an all-zero result is refused, RFC 8731 §3.
export function sharedSecret(privateKey: KeyObject, peer: Buffer): Buffer {
    const secret = diffieHellman({ privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: peer.toString("base64url") }, format: "jwk" }) });
    if (secret.every((byte) => byte === 0)) throw new Error("X25519 shared secret is all zero");
    return secret;
}

// A big-endian magnitude without its leading zero bytes, as JWK wants it.
function unsigned(value: Buffer): Buffer {
    const start = value.findIndex((byte) => byte !== 0);
    return value.subarray(start === -1 ? value.length : start);
}

// Whether `signature` over `hash` verifies under the host key `blob`, for the negotiated `algorithm`.
export function isSignatureValid(algorithm: string, blob: Buffer, signature: Buffer, hash: Buffer): boolean {
    const key = new Fields(blob);
    const type = key.text();
    const signed = new Fields(signature);
    if (signed.text() !== (type === "ssh-rsa" ? algorithm : type)) return false;
    const value = signed.bytes();
    if (type === "ssh-ed25519" || type === "ssh-ed448") {
        const crv = type === "ssh-ed25519" ? "Ed25519" : "Ed448";
        return verify(undefined, hash, createPublicKey({ key: { kty: "OKP", crv, x: key.bytes().toString("base64url") }, format: "jwk" }), value);
    }
    if (type.startsWith("ecdsa-sha2-")) {
        const curve = CURVES[key.text()];
        const point = key.bytes();
        if (!curve || point[0] !== 4 || point.length !== 1 + 2 * curve.size) return false;
        const pair = new Fields(value);
        const rs = Buffer.concat([pair.bytes(), pair.bytes()].map((part) => unsigned(part)).map((part) => Buffer.concat([Buffer.alloc(Math.max(0, curve.size - part.length)), part])));
        const jwk = { kty: "EC", crv: curve.crv, x: point.subarray(1, 1 + curve.size).toString("base64url"), y: point.subarray(1 + curve.size).toString("base64url") };
        return verify(curve.hash, hash, { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, rs);
    }
    if (type === "ssh-rsa" && (algorithm === "rsa-sha2-256" || algorithm === "rsa-sha2-512")) {
        const exponent = unsigned(key.bytes()).toString("base64url");
        const modulus = unsigned(key.bytes()).toString("base64url");
        return verify(algorithm === "rsa-sha2-256" ? "sha256" : "sha512", hash, createPublicKey({ key: { kty: "RSA", n: modulus, e: exponent }, format: "jwk" }), value);
    }
    return false;
}

// The byte count of the complete packet heading `buffer`, undefined while it is still arriving.
function packetLength(buffer: Buffer): number | undefined {
    if (buffer.length < 4) return undefined;
    const length = buffer.readUInt32BE(0);
    if (length > MAX_PACKET || length < 5) throw new Error(`SSH packet length ${length} outside RFC 4253 §6.1`);
    return buffer.length >= 4 + length ? 4 + length : undefined;
}

// A TCP connect that failed, which says the port is closed or filtered rather than that SSH misbehaved.
export class Unreachable extends Error {}

// Buffers a socket and hands out identification lines and binary packets as they complete.
export class Wire {
    #buffer = Buffer.alloc(0);
    #wake: () => void = () => {};
    #failure?: Error;

    constructor(socket: Socket) {
        socket.on("data", (chunk: Buffer) => {
            this.#buffer = Buffer.concat([this.#buffer, chunk]);
            this.#wake();
        });
        socket.once("error", (error) => {
            this.#failure ??= error;
            this.#wake();
        });
        socket.once("close", () => {
            this.#failure ??= new Error("SSH connection closed");
            this.#wake();
        });
    }

    // The first `length` bytes once `measure` can tell how many make a unit.
    async #take(measure: (buffer: Buffer) => number | undefined): Promise<Buffer> {
        for (;;) {
            const length = measure(this.#buffer);
            if (length !== undefined) {
                const unit = this.#buffer.subarray(0, length);
                this.#buffer = this.#buffer.subarray(length);
                return unit;
            }
            if (this.#buffer.length > MAX_PACKET) throw new Error(`SSH peer sent ${this.#buffer.length} bytes without a complete unit`);
            if (this.#failure) throw this.#failure;
            await new Promise<void>((resolve) => (this.#wake = resolve));
        }
    }

    // One line, without CR LF.
    async line(): Promise<string> {
        const raw = await this.#take((buffer) => (buffer.includes(10) ? buffer.indexOf(10) + 1 : undefined));
        return raw.toString("latin1").replace(/\r?\n$/, "");
    }

    // The next payload other than IGNORE and DEBUG; DISCONNECT throws its reason.
    async payload(): Promise<Buffer> {
        for (;;) {
            const raw = await this.#take(packetLength);
            const payload = raw.subarray(5, raw.length - raw.readUInt8(4));
            const type = payload[0];
            if (type === MSG.disconnect) throw new Error(`SSH peer disconnected: ${new Fields(payload, 5).text()}`);
            if (type !== MSG.ignore && type !== MSG.debug) return payload;
        }
    }
}

// One ML-KEM hybrid or curve25519 key exchange offering `algorithms`, abandoned after the server’s signed reply; throws when the signature does not verify.
export async function hostKey(address: string, port: number, algorithms: string[], signal: AbortSignal): Promise<HostKey> {
    signal.throwIfAborted();
    const socket = new Socket();
    const stop = () => socket.destroy(new Error(`SSH port ${port} of ${address} gave no answer in time`));
    signal.addEventListener("abort", stop, { once: true });
    try {
        const wire = new Wire(socket);
        await new Promise<void>((resolve, reject) => socket.once("error", (error) => reject(new Unreachable(error.message))).connect(port, address, () => resolve()));
        const clientInit = kexinit(KEX, algorithms);
        socket.write(`${IDENTIFICATION}\r\n`);
        socket.write(packet(clientInit));
        let banner = await wire.line();
        for (let lines = 1; !banner.startsWith("SSH-"); lines += 1) {
            if (lines > 32) throw new Error("SSH peer sent no identification line");
            banner = await wire.line();
        }
        if (!/^SSH-(2\.0|1\.99)-/.test(banner)) throw new Error(`SSH peer speaks another protocol version: ${banner}`);
        let serverInit = await wire.payload();
        while (serverInit[0] !== MSG.kexinit) serverInit = await wire.payload();
        const offered = kexinitLists(serverInit);
        const kex = KEX.find((name) => offered.kex.includes(name));
        const algorithm = algorithms.find((name) => offered.hostKeys.includes(name));
        log.debug({ address, port, banner, kex, algorithm, offered: offered.hostKeys }, "SSH algorithms negotiated");
        if (!kex) throw new Error(`SSH peer offers no key exchange this client speaks: ${offered.kex.join(",")}`);
        if (!algorithm) return { banner, offered: offered.hostKeys };
        const ours = keyShare(kex);
        const init = Buffer.concat([Buffer.from([MSG.kexInit]), sshString(ours.share)]);
        socket.write(packet(init));
        let reply = await wire.payload();
        while (reply[0] !== MSG.kexReply) reply = await wire.payload();
        const fields = new Fields(reply, 1);
        const blob = fields.bytes();
        const serverShare = fields.bytes();
        const signature = fields.bytes();
        const hash = exchangeHash({ client: IDENTIFICATION, server: banner, clientInit, serverInit, blob, clientShare: ours.share, serverShare, secret: ours.secret(serverShare) });
        if (!isSignatureValid(algorithm, blob, signature, hash)) throw new Error(`SSH host key signature of ${address} does not verify for ${algorithm}`);
        return { banner, offered: offered.hostKeys, blob };
    } finally {
        signal.removeEventListener("abort", stop);
        socket.destroy();
    }
}
