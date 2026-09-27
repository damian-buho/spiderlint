// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP, type BlockList } from "node:net";
import { log } from "../logger.ts";

const SWEEP_MS = 60_000;

// An IPv4-mapped IPv6 address as its IPv4 form.
function plain(address: string): string {
    return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
}

function isTrusted(address: string, trusted: BlockList): boolean {
    return isIP(address) !== 0 && trusted.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// The peer, or while the hop in hand is a trusted proxy, the X-Forwarded-For entry it added, read right to left.
export function clientOf(peer: string, forwarded: string | undefined, trusted: BlockList): string {
    let client = plain(peer);
    const hops = (forwarded ?? "").split(",").map((entry) => plain(entry.trim())).toReversed();
    for (const hop of hops) {
        if (!isTrusted(client, trusted) || isIP(hop) === 0) break;
        client = hop;
    }
    return client;
}

// Token buckets per client address, in memory only, so an address never reaches Redis or a log.
export class Buckets {
    readonly #buckets = new Map<string, { tokens: number; at: number }>();
    #swept = 0;

    // Forgets buckets full again, at most once a minute.
    #sweep(jobs: number, perMs: number, now: number): void {
        if (now - this.#swept < SWEEP_MS) return;
        this.#swept = now;
        for (const [client, bucket] of this.#buckets) if (bucket.tokens + (now - bucket.at) * perMs >= jobs) this.#buckets.delete(client);
        log.debug({ clients: this.#buckets.size }, "client buckets swept");
    }

    // Takes a token from the bucket of `rate.jobs` refilled evenly over `rate.seconds`; 0 when taken, else the seconds until one is back.
    take(client: string, rate: { jobs: number; seconds: number }, now = Date.now()): number {
        const perMs = rate.jobs / (rate.seconds * 1000);
        this.#sweep(rate.jobs, perMs, now);
        const bucket = this.#buckets.get(client);
        const tokens = bucket ? Math.min(rate.jobs, bucket.tokens + (now - bucket.at) * perMs) : rate.jobs;
        const isTaken = tokens >= 1;
        this.#buckets.set(client, { tokens: isTaken ? tokens - 1 : tokens, at: now });
        const wait = isTaken ? 0 : Math.ceil((1 - tokens) / perMs / 1000);
        log.debug({ tokens: Math.floor(tokens), jobs: rate.jobs, wait }, "client bucket taken");
        return wait;
    }
}
