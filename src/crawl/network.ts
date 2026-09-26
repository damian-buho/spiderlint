// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { setGlobalProxyFromEnv } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "proxy-chain";
import { ConfigError, type Config } from "../config/index.ts";
import { log } from "../logger.ts";
import { openResolution } from "./resolve.ts";

const SOCKS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

// Milliseconds between two requests, and when the next may start.
const pacing = { spacing: 0, next: 0 };

// Waits for the next slot under `rate`; unlimited returns at once.
export async function pace(): Promise<void> {
    if (pacing.spacing === 0) return;
    const now = Date.now();
    const slot = Math.max(now, pacing.next);
    pacing.next = slot + pacing.spacing;
    log.trace({ waitMs: slot - now, spacing: pacing.spacing }, "request paced");
    if (slot > now) await sleep(slot - now);
}

export interface Network {
    // The HTTP proxy Crawlee and Chromium are given: the configured one, or the local bridge to a SOCKS one.
    proxy?: string;
    close(): Promise<void>;
}

// Paces, and routes every HTTP client of one run through `config.proxy`, until `close`.
export async function openNetwork(config: Pick<Config, "proxy" | "rate" | "allowPrivate" | "resolver" | "resolve" | "seeds">): Promise<Network> {
    pacing.spacing = config.rate > 0 ? 60_000 / config.rate : 0;
    pacing.next = 0;
    log.debug({ rate: config.rate, spacing: pacing.spacing, isProxied: config.proxy !== "" }, "network opened");
    const unresolve = await openResolution(config.resolve, config.resolver, config.seeds, config.proxy !== "");
    const reset = () => {
        pacing.spacing = 0;
        unresolve();
    };
    if (!config.proxy) return { close: async () => reset() };
    if (!config.allowPrivate) throw new ConfigError("proxy: the address guard cannot check what a proxy connects to");
    const upstream = new URL(config.proxy);
    const bridge = SOCKS.has(upstream.protocol) ? new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ upstreamProxyUrl: config.proxy }) }) : undefined;
    await bridge?.listen();
    const proxy = bridge ? `http://127.0.0.1:${bridge.port}` : config.proxy;
    const restore = setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy });
    log.info({ proxy: `${upstream.protocol}//${upstream.host}`, isBridged: bridge !== undefined }, "requests go through the proxy");
    return {
        proxy,
        async close() {
            restore();
            reset();
            await bridge?.close(true);
        },
    };
}
