// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import { isIP, type LookupFunction } from "node:net";
import { Bucket } from "../cache/index.ts";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { dnsClient, type DnsClient, type StoredReply } from "./dns.ts";
import { reason } from "./fetch.ts";

// One `--resolve` pin: every connection to `host` goes to `address`.
export interface Pin {
    host: string;
    address: string;
}

// Chromium’s `--host-resolver-rules` for the open run, empty when nothing is pinned.
const browser = { hostRules: "" };

// `host:address`, or curl’s `host:port:address` whose port is accepted and ignored, since a lookup never sees it.
export function parsePin(raw: string): Pin {
    const match = /^([^:[\]\s]+)(?::\d+)?:(\[[^\]]+\]|[^:[\]\s]+)$/.exec(raw.trim());
    const address = match?.[2]?.replaceAll(/^\[|\]$/g, "") ?? "";
    if (!match || isIP(address) === 0) throw new ConfigError(`resolve: invalid pin ${raw} (expected host[:port]:address)`);
    return { host: (match[1] as string).toLowerCase(), address };
}

function answer(addresses: LookupAddress[], options: LookupOptions, callback: Parameters<LookupFunction>[2]): void {
    const [first] = addresses;
    // eslint-disable-next-line unicorn/no-null -- the lookup callback contract types a success as a null error
    callback(null, options.all ? addresses : (first?.address ?? ""), first?.family ?? 0);
}

function notFound(hostname: string, why: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (${why})`), { code: "ENOTFOUND", hostname });
}

// A and AAAA of `hostname` from `client`, IPv4 first, restricted to `family` when it is 4 or 6.
async function addressesOf(client: DnsClient, hostname: string, family: number): Promise<LookupAddress[]> {
    const types = family === 4 ? ["A"] : family === 6 ? ["AAAA"] : ["A", "AAAA"];
    const replies = await Promise.all(types.map((type) => client.query(hostname, type)));
    return replies.flatMap((reply) => reply.answers.flatMap((record) => (record.type === "A" || record.type === "AAAA" ? [{ address: record.data as string, family: record.type === "A" ? 4 : 6 }] : [])));
}

// Pins first, then the configured servers, `localhost` always from the system; every answer is kept for the run.
function crawlLookup(pins: readonly Pin[], client: DnsClient | undefined, system: typeof dns.lookup): LookupFunction {
    const answers = new Map<string, Promise<LookupAddress[]>>();
    return (hostname, options, callback) => {
        const name = hostname.toLowerCase().replace(/\.$/, "");
        const pin = pins.find((entry) => entry.host === name);
        if (pin) {
            log.debug({ hostname, address: pin.address }, "name pinned by --resolve");
            answer([{ address: pin.address, family: isIP(pin.address) }], options, callback);
            return;
        }
        if (!client || name === "localhost" || name.endsWith(".localhost")) {
            system(hostname, options, callback);
            return;
        }
        const family = Number(options.family ?? 0);
        const key = `${name}\t${family}`;
        let pending = answers.get(key);
        if (!pending) {
            pending = addressesOf(client, name, family);
            answers.set(key, pending);
        }
        const settle = async (asked: Promise<LookupAddress[]>) => {
            let addresses: LookupAddress[];
            try {
                addresses = await asked;
            } catch (error) {
                log.debug({ hostname, error: reason(error) }, "resolver lookup failed");
                callback(notFound(hostname, reason(error)), "", 0);
                return;
            }
            log.debug({ hostname, family, addresses: addresses.map((entry) => entry.address) }, "name resolved through the resolver");
            if (addresses.length === 0) callback(notFound(hostname, "no address from the resolver"), "", 0);
            else answer(addresses, options, callback);
        };
        void settle(pending);
    };
}

// `MAP host address` per pin, then per seed host the resolver answers; Chromium resolves any other name itself.
async function chromiumRules(pins: readonly Pin[], seeds: readonly string[], client: DnsClient | undefined): Promise<string> {
    const mapped = new Map(pins.map((pin) => [pin.host, pin.address]));
    const hosts = [...new Set(seeds.flatMap((seed) => (URL.canParse(seed) ? [new URL(seed).hostname] : [])))].filter((host) => isIP(host.replaceAll(/^\[|\]$/g, "")) === 0 && !mapped.has(host));
    if (client) {
        for (const host of hosts) {
            try {
                const [first] = await addressesOf(client, host, 0);
                log.debug({ host, address: first?.address }, "seed host resolved for the browser");
                if (first) mapped.set(host, first.address);
            } catch (error) {
                log.warn({ host, error: reason(error) }, "seed host unresolved for the browser; Chromium asks the system");
            }
        }
    }
    return [...mapped].map(([host, address]) => `MAP ${host} ${isIP(address) === 6 ? `[${address}]` : address}`).join(", ");
}

// Chromium launch arguments for the open run’s pins and resolver.
export function chromiumArguments(): string[] {
    return browser.hostRules ? [`--host-resolver-rules=${browser.hostRules}`] : [];
}

// Swaps `dns.lookup` so got, fetch, probes and TLS handshakes resolve through pins and `resolver`; returns the restore.
export async function openResolution(pins: readonly Pin[], resolver: string, seeds: readonly string[], isProxied: boolean): Promise<() => void> {
    const isSystem = resolver === "system";
    if (isSystem && pins.length === 0) return () => {};
    if (isProxied) {
        log.warn({ pins: pins.length, resolver }, "names resolve inside the proxy; --resolve and --resolver do not reach the crawl");
        return () => {};
    }
    const client = isSystem ? undefined : dnsClient(resolver, new Bucket<StoredReply>("dns", undefined, 60, "off"), false);
    const system = dns.lookup;
    dns.lookup = crawlLookup(pins, client, system) as typeof dns.lookup;
    syncBuiltinESMExports();
    browser.hostRules = await chromiumRules(pins, seeds, client);
    log.info({ pins: pins.map((pin) => pin.host), resolver, browserRules: browser.hostRules }, "crawl resolves names through the configured resolution");
    return () => {
        dns.lookup = system;
        syncBuiltinESMExports();
        browser.hostRules = "";
    };
}
