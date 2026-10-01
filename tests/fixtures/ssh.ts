// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createPublicKey, encapsulate, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { exchangeHash, Fields, HYBRID, hybridSecret, kexinit, mpint, packet, sharedSecret, sshString, Wire, x25519 } from "../../src/crawl/ssh.ts";

const BANNER = "SSH-2.0-fixture";

export interface SshKey {
    // The signature algorithm a KEXINIT lists for it.
    algorithm: string;
    blob: Buffer;
    privateKey: KeyObject;
}

export interface SshFixture {
    port: number;
    close(): Promise<void>;
}

// A fresh Ed25519 host key.
export function ed25519(): SshKey {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
    return { algorithm: "ssh-ed25519", blob: Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]), privateKey };
}

// A fresh ECDSA P-256 host key.
export function ecdsa(): SshKey {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x as string, "base64url"), Buffer.from(jwk.y as string, "base64url")]);
    return { algorithm: "ecdsa-sha2-nistp256", blob: Buffer.concat([sshString("ecdsa-sha2-nistp256"), sshString("nistp256"), sshString(point)]), privateKey };
}

// A fresh 2048-bit RSA host key, signed with SHA-512.
export function rsa(): SshKey {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const exponent = mpint(Buffer.from(jwk.e as string, "base64url"));
    const modulus = mpint(Buffer.from(jwk.n as string, "base64url"));
    return { algorithm: "rsa-sha2-512", blob: Buffer.concat([sshString("ssh-rsa"), exponent, modulus]), privateKey };
}

// The RFC 4253 §6.6 signature blob of `key` over `hash`.
function signature(key: SshKey, hash: Buffer): Buffer {
    if (key.algorithm === "ssh-ed25519") return Buffer.concat([sshString(key.algorithm), sshString(sign(undefined, hash, key.privateKey))]);
    if (key.algorithm === "rsa-sha2-512") return Buffer.concat([sshString(key.algorithm), sshString(sign("sha512", hash, key.privateKey))]);
    const rs = sign("sha256", hash, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
    const pair = Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]);
    return Buffer.concat([sshString(key.algorithm), sshString(pair)]);
}

// The server share of `kex` for a client share, and the encoded shared secret K.
function serverShare(kex: string, client: Buffer): { share: Buffer; secret: Buffer } {
    const ours = x25519();
    if (kex !== HYBRID) return { share: ours.raw, secret: mpint(sharedSecret(ours.privateKey, client)) };
    const jwk = { kty: "AKP", alg: "ML-KEM-768", pub: client.subarray(0, -32).toString("base64url") } as unknown as JsonWebKey;
    const { sharedKey, ciphertext } = encapsulate(createPublicKey({ key: jwk, format: "jwk" }));
    return { share: Buffer.concat([ciphertext, ours.raw]), secret: hybridSecret(sharedKey, sharedSecret(ours.privateKey, client.subarray(-32))) };
}

// One server side of a key exchange over `kex`, signing with `forger` in place of the key it presents when set.
async function answer(socket: Socket, keys: SshKey[], kex: string[], forger?: SshKey): Promise<void> {
    const wire = new Wire(socket);
    const serverInit = kexinit(kex, keys.map((key) => key.algorithm));
    socket.write(`${BANNER}\r\n`);
    socket.write(packet(serverInit));
    const client = await wire.line();
    const clientInit = await wire.payload();
    const wanted = new Fields(clientInit, 17);
    const method = wanted.list().find((name) => kex.includes(name)) ?? "";
    const asked = wanted.list();
    const key = keys.find((candidate) => candidate.algorithm === asked.find((name) => keys.some((offered) => offered.algorithm === name)));
    if (!key) return void socket.end();
    const init = new Fields(await wire.payload(), 1);
    const clientShare = init.bytes();
    const ours = serverShare(method, clientShare);
    const hash = exchangeHash({ client, server: BANNER, clientInit, serverInit, blob: key.blob, clientShare, serverShare: ours.share, secret: ours.secret });
    const signed = signature(forger ? { ...forger, algorithm: key.algorithm } : key, hash);
    const reply = Buffer.concat([Buffer.from([31]), sshString(key.blob), sshString(ours.share), sshString(signed)]);
    socket.write(packet(reply));
}

// An SSH server on an ephemeral loopback port presenting `keys` over `kex`; `stall` accepts and never speaks, `forger` signs with the wrong key.
export async function serveSsh(keys: SshKey[], options: { stall?: true; forger?: SshKey; kex?: string[] } = {}): Promise<SshFixture> {
    const sockets = new Set<Socket>();
    const server = createServer(async (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        if (options.stall) return;
        try {
            await answer(socket, keys, options.kex ?? [HYBRID, "curve25519-sha256"], options.forger);
        } catch {
            socket.destroy();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as AddressInfo).port,
        close: () => {
            for (const socket of sockets) socket.destroy();
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}
