// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "node:tls";
import { tlsFacts } from "../facts/transport.ts";
import type { TlsFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { delay, reason } from "./fetch.ts";
import { guardedLookup, isPrivate, PrivateAddress } from "./guard.ts";

const ATTEMPTS = 2;
const TIMEOUT_MS = 10_000;
const ALPN = ["h2", "http/1.1"];

// One handshake to `host` at `address`, read and closed; the certificate is judged, never enforced.
async function handshake(host: string, port: number, address: string | undefined, isPrivateAllowed: boolean): Promise<TlsFacts | undefined> {
    if (!isPrivateAllowed && address && isPrivate(address)) throw new PrivateAddress(`${address} is a private address`);
    const servername = isIP(host) === 0 ? host : undefined;
    return new Promise((resolve, reject) => {
        const socket = connect({ host: address ?? host, port, ...(servername && { servername }), ALPNProtocols: ALPN, rejectUnauthorized: false, timeout: TIMEOUT_MS, ...(!isPrivateAllowed && { lookup: guardedLookup }) });
        socket.once("secureConnect", () => {
            resolve(tlsFacts(socket));
            socket.end();
        });
        socket.once("timeout", () => socket.destroy(new Error(`TLS handshake with ${host}:${port} timed out`)));
        socket.once("error", reject);
    });
}

// Handshakes once per (host, port, address) a browser crawl connected to, for the cipher, ALPN, SAN and fingerprint Chromium does not report.
export class TlsProber {
    readonly #answers = new Map<string, Promise<TlsFacts | undefined>>();
    readonly #isPrivateAllowed: boolean;

    constructor(isPrivateAllowed: boolean) {
        this.#isPrivateAllowed = isPrivateAllowed;
    }

    // One probe with a retry after a failure other than a refused address.
    async #retrying(host: string, port: number, address: string | undefined): Promise<TlsFacts | undefined> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                const facts = await handshake(host, port, address, this.#isPrivateAllowed);
                log.debug({ host, port, address, attempt, protocol: facts?.protocol, alpn: facts?.alpn }, "TLS probed");
                return facts;
            } catch (error) {
                const isLast = attempt === ATTEMPTS - 1 || error instanceof PrivateAddress;
                log[isLast ? "warn" : "debug"]({ host, port, address, attempt, error: reason(error) }, "TLS probe failed");
                if (isLast) return undefined;
                await sleep(delay(attempt));
            }
        }
    }

    // Handshakes sent, one per distinct key.
    get probes(): number {
        return this.#answers.size;
    }

    // The TLS facts of `url`’s host at `address`, undefined off `https:` or once both attempts fail.
    facts(url: URL, address?: string): Promise<TlsFacts | undefined> {
        if (url.protocol !== "https:") return Promise.resolve(undefined);
        const port = Number(url.port || 443);
        const host = url.hostname.replaceAll(/^\[|\]$/g, "");
        const key = `${host}:${port}@${address ?? ""}`;
        const known = this.#answers.get(key);
        if (known) return known;
        const answer = this.#retrying(host, port, address);
        this.#answers.set(key, answer);
        return answer;
    }
}
