// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from "node:events";
import { setGlobalProxyFromEnv } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { Server } from "proxy-chain";
import { getDomain } from "tldts";
import { ConfigError, defaults, type Config } from "../config/index.ts";
import { log } from "../logger.ts";
import { refuseLiteral } from "./guard.ts";
import { openResolution } from "./resolve.ts";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const SOCKS = new Set(["socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);

// Milliseconds between two requests, when the next may start, and the run’s `timeout` over its default.
const pacing = { spacing: 0, next: 0, scale: 1 };

// Path extensions CrowdSec’s `http-logs` parser marks static, which its probing and crawl scenarios never count.
const STATIC = new Set([".jpg", ".css", ".js", ".jpeg", ".png", ".svg", ".map", ".ico", ".otf", ".gif", ".mp3", ".mp4", ".woff", ".woff2", ".ttf", ".eot", ".webp", ".wav", ".gz", ".brotli", ".bvr", ".ts", ".bmp", ".avif", ".mjs", ".tgz"]);

// Whether the open run may reach loopback, private and link-local addresses.
const guard = { isPrivateAllowed: true };

// Throws for a private address literal while the open run refuses private addresses.
export function guardUrl(url: string | URL): void {
    refuseLiteral(url, guard.isPrivateAllowed);
}

// `fetch`, following redirects itself while the guard is on, so every hop’s address literal is checked as the first one was.
export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
    guardUrl(url);
    if (guard.isPrivateAllowed) return fetch(url, init);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await fetch(current, { ...init, redirect: "manual" });
        const location = response.headers.get("location");
        if (location === null || !REDIRECTS.has(response.status)) return response;
        await response.body?.cancel();
        const next = new URL(location, current).href;
        log.debug({ from: current, to: next, status: response.status, hop }, "redirect followed");
        guardUrl(next);
        current = next;
    }
    throw new TypeError(`${url}: more than ${MAX_REDIRECTS} redirects`);
}

// `ms` stretched by the run’s `timeout`, so a slow network gets as long as a page does.
export function patient(ms: number): number {
    return ms * pacing.scale;
}

// Waits for the next slot under `rate`; unlimited returns at once.
export async function pace(): Promise<void> {
    if (pacing.spacing === 0) return;
    const now = Date.now();
    const slot = Math.max(now, pacing.next);
    pacing.next = slot + pacing.spacing;
    log.trace({ waitMs: slot - now, spacing: pacing.spacing }, "request paced");
    if (slot > now) await sleep(slot - now);
}

// Waits for `work`, or stops waiting once `signal` aborts, leaving `work` to the process exit.
export async function until(work: Promise<unknown>, signal: AbortSignal): Promise<void> {
    await Promise.race([work, signal.aborted ? undefined : once(signal, "abort")]);
}

// An abort signal whose countdown stops while any request under it waits for a domain budget.
export class Deadline {
    readonly #controller = new AbortController();
    #remaining: number;
    #ends = 0;
    #waiting = 0;
    #timer?: NodeJS.Timeout;
    readonly signal = this.#controller.signal;

    constructor(ms: number) {
        this.#remaining = ms;
        this.#start();
    }

    #start(): void {
        this.#ends = Date.now() + this.#remaining;
        this.#timer = setTimeout(() => this.#controller.abort(new DOMException("deadline passed", "TimeoutError")), this.#remaining).unref();
    }

    pause(): void {
        this.#waiting += 1;
        if (this.#waiting > 1) return;
        clearTimeout(this.#timer);
        this.#remaining = Math.max(0, this.#ends - Date.now());
        log.trace({ remainingMs: this.#remaining }, "deadline paused");
    }

    resume(): void {
        this.#waiting -= 1;
        if (this.#waiting > 0 || this.signal.aborted) return;
        log.trace({ remainingMs: this.#remaining }, "deadline resumed");
        this.#start();
    }
}

// Whether `host` is this machine, where no firewall stands between the request and the site.
function isLoopback(host: string): boolean {
    const literal = host.replaceAll(/^\[|\]$/g, "");
    return literal === "localhost" || literal.endsWith(".localhost") || literal === "::1" || literal.startsWith("127.");
}

// A leaky bucket per registrable domain holding at most `burst`, leaking `perMinute`; 0 per minute is unlimited.
class Budget {
    readonly #domains = new Map<string, { level: number; at: number }>();
    perMinute = 0;
    burst = 0;

    #drained(domain: string, now: number): { level: number; at: number } {
        const bucket = this.#domains.get(domain) ?? { level: 0, at: now };
        bucket.level = Math.max(0, bucket.level - ((now - bucket.at) * this.perMinute) / 60_000);
        bucket.at = now;
        this.#domains.set(domain, bucket);
        return bucket;
    }

    configure(perMinute: number, burst: number): void {
        this.perMinute = perMinute;
        this.burst = Math.max(1, Math.floor(burst));
        this.#domains.clear();
    }

    // Milliseconds until `domain` has room for one more, 0 when it has now.
    wait(domain: string, now: number): number {
        if (this.perMinute === 0) return 0;
        const over = this.#drained(domain, now).level - (this.burst - 1);
        return over > 0 ? Math.ceil((over * 60_000) / this.perMinute) : 0;
    }

    take(domain: string, now: number): void {
        if (this.perMinute > 0) this.#drained(domain, now).level += 1;
    }

    give(domain: string, now: number): void {
        if (this.perMinute === 0) return;
        const bucket = this.#drained(domain, now);
        bucket.level = Math.max(0, bucket.level - 1);
    }
}

// Non-static requests and 4xx answers each registrable domain may receive, as `requests` and `misses` set them.
const budgets = { requests: new Budget(), misses: new Budget() };

// Milliseconds until `domain` has room under both budgets.
function waitOf(domain: string, now: number): number {
    return Math.max(budgets.requests.wait(domain, now), budgets.misses.wait(domain, now));
}

// Whether the last segment of `pathname` carries an extension CrowdSec counts as static.
function isStatic(pathname: string): boolean {
    const extension = /\.[^./]+$/.exec(pathname)?.[0];
    return extension !== undefined && STATIC.has(extension.toLowerCase());
}

// The registrable domain `href` is budgeted under; undefined for a static file, loopback or anything but http(s).
function budgeted(href: string): string | undefined {
    const url = URL.canParse(href) ? new URL(href) : undefined;
    const isBudgeted = url !== undefined && ["http:", "https:"].includes(url.protocol) && !isLoopback(url.hostname) && !isStatic(url.pathname);
    return isBudgeted ? (getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname) : undefined;
}

// Charges a request made on spiderlint’s behalf without `admit`, and a miss when `status` is a 4xx; the next `admit` waits for them.
export function charge(href: string, status: number, now: () => number = Date.now): void {
    const domain = budgeted(href);
    if (domain === undefined) return;
    budgets.requests.take(domain, now());
    if (status >= 400 && status <= 499) budgets.misses.take(domain, now());
    log.trace({ url: href, domain, status }, "request charged");
}

// Waits until `href`’s registrable domain has room for one request and one miss, pausing `deadline` meanwhile, takes both, and returns what gives the miss back unless the answer is a 4xx.
export async function admit(href: string, signal?: AbortSignal, deadline?: Deadline, now: () => number = Date.now): Promise<(status: number) => void> {
    const domain = budgeted(href);
    if (domain === undefined) return () => {};
    for (let waitMs = waitOf(domain, now()); waitMs > 0; waitMs = waitOf(domain, now())) {
        log.debug({ url: href, domain, waitMs }, "request waits for the domain’s budget");
        deadline?.pause();
        try {
            await sleep(waitMs, undefined, { signal });
        } finally {
            deadline?.resume();
        }
    }
    budgets.requests.take(domain, now());
    budgets.misses.take(domain, now());
    return (status) => {
        if (status >= 400 && status <= 499) return log.trace({ url: href, domain, status }, "request answered a miss");
        budgets.misses.give(domain, now());
    };
}

export interface Network {
    // The HTTP proxy Crawlee and Chromium are given: the configured one, or the local bridge to a SOCKS one.
    proxy?: string;
    close(): Promise<void>;
}

// Paces, and routes every HTTP client of one run through `config.proxy`, until `close`.
export async function openNetwork(config: Pick<Config, "proxy" | "rate" | "requests" | "misses" | "timeout" | "allowPrivate" | "resolver" | "resolve" | "seeds">): Promise<Network> {
    pacing.spacing = config.rate > 0 ? 60_000 / config.rate : 0;
    pacing.next = 0;
    pacing.scale = config.timeout / defaults().timeout;
    budgets.requests.configure(config.requests, config.requests / 3);
    budgets.misses.configure(config.misses, config.misses);
    log.debug({ rate: config.rate, requests: config.requests, misses: config.misses, spacing: pacing.spacing, scale: pacing.scale, isProxied: config.proxy !== "" }, "network opened");
    guard.isPrivateAllowed = config.allowPrivate;
    const unresolve = await openResolution(config.resolve, config.resolver, config.seeds, config.proxy !== "", config.allowPrivate);
    const reset = () => {
        pacing.spacing = 0;
        pacing.scale = 1;
        budgets.requests.configure(0, 0);
        budgets.misses.configure(0, 0);
        guard.isPrivateAllowed = true;
        unresolve();
    };
    if (!config.proxy) return { close: async () => reset() };
    if (!config.allowPrivate) throw new ConfigError("proxy: the address guard cannot check what a proxy connects to");
    const upstream = new URL(config.proxy);
    const bridge = SOCKS.has(upstream.protocol) ? new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction: () => ({ upstreamProxyUrl: config.proxy }) }) : undefined;
    await bridge?.listen();
    const proxy = bridge ? `http://127.0.0.1:${bridge.port}` : config.proxy;
    const restore = setGlobalProxyFromEnv({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy });
    log.debug({ proxy: `${upstream.protocol}//${upstream.host}`, isBridged: bridge !== undefined }, "requests go through the proxy");
    return {
        proxy,
        async close() {
            restore();
            reset();
            await bridge?.close(true);
        },
    };
}
