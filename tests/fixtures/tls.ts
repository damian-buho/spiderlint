// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type TlsOptions } from "node:tls";

export interface TlsFixture {
    origin: string;
    close(): Promise<void>;
}

// A self-signed localhost certificate from `openssl`, naming an OCSP responder when `isOcsp`; undefined where `openssl` is not on PATH.
export function certificate(isOcsp = false): { key: Buffer; cert: Buffer } | undefined {
    const directory = mkdtempSync(path.join(tmpdir(), "spiderlint-tls-"));
    const [key, cert] = [path.join(directory, "key.pem"), path.join(directory, "cert.pem")];
    try {
        // eslint-disable-next-line unicorn/prefer-https -- an OCSP responder is named by a plain http URI (RFC 6960 Appendix A)
        const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", ...(isOcsp ? ["-addext", "authorityInfoAccess=OCSP;URI:http://ocsp.test/"] : []), "-keyout", key, "-out", cert], { stdio: "ignore" });
        return made.status === 0 ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

// A TLS server speaking `alpn` within `versions`, stapling `ocsp` when given, closing each connection once it is up.
export async function serveTls(alpn = ["h2", "http/1.1"], versions: Pick<TlsOptions, "minVersion" | "maxVersion" | "ciphers" | "honorCipherOrder"> = {}, ocsp?: Buffer): Promise<TlsFixture | undefined> {
    const pair = certificate(ocsp !== undefined);
    if (!pair) return undefined;
    const fixture = { origin: "", close: async () => {} };
    const server = createServer({ ...pair, ...versions, ALPNProtocols: alpn }, (socket) => socket.end());
    if (ocsp) server.on("OCSPRequest", (_certificate: Buffer, _issuer: Buffer, callback: (error: Error | undefined, response: Buffer) => void) => callback(undefined, ocsp));
    const sockets = new Set<Socket>();
    server.on("connection", (socket: Socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixture.origin = `https://localhost:${(server.address() as AddressInfo).port}`;
    fixture.close = () => new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
    });
    return fixture;
}
