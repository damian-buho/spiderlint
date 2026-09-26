// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:tls";

export interface TlsFixture {
    origin: string;
    close(): Promise<void>;
}

// A self-signed localhost certificate from `openssl`, undefined where it is not on PATH.
function certificate(): { key: Buffer; cert: Buffer } | undefined {
    const directory = mkdtempSync(path.join(tmpdir(), "spiderlint-tls-"));
    const [key, cert] = [path.join(directory, "key.pem"), path.join(directory, "cert.pem")];
    try {
        const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", key, "-out", cert], { stdio: "ignore" });
        return made.status === 0 ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined;
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

// A TLS server speaking `alpn`, closing each connection once it is up.
export async function serveTls(alpn = ["h2", "http/1.1"]): Promise<TlsFixture | undefined> {
    const pair = certificate();
    if (!pair) return undefined;
    const fixture = { origin: "", close: async () => {} };
    const server = createServer({ ...pair, ALPNProtocols: alpn }, (socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fixture.origin = `https://localhost:${(server.address() as AddressInfo).port}`;
    fixture.close = () => new Promise((resolve) => server.close(() => resolve()));
    return fixture;
}
