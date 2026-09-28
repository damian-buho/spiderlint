// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { userCacheDirectory, writeAtomic } from "../cache/index.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";
import type { Probe, ProbeInit } from "./probe.ts";

// RFC 9224 §4: the IANA bootstrap mapping TLDs to RDAP base URLs.
export const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
const FRESH_MS = 86_400_000;
const STALE_LOCK_MS = 30_000;

// A GET or HEAD through the run’s guarded probe.
type Get = (url: string, init?: ProbeInit) => Promise<Probe>;

// Suffix lists beside the base URLs serving them.
type Services = [string[], string[]][];

interface Stored {
    fetched: string;
    services: Services;
}

// What a registry’s RDAP answer says about one domain.
export interface Registration {
    server: string;
    status?: string[];
    expires?: string;
    nameservers: string[];
}

const bootstrapFile = (): string => path.join(userCacheDirectory(), "rdap", "dns.json");

// The stored bootstrap, however old; none when absent or unreadable.
async function stored(): Promise<Stored | undefined> {
    try {
        return JSON.parse(await readFile(bootstrapFile(), "utf8")) as Stored;
    } catch (error) {
        log.debug({ file: bootstrapFile(), error: reason(error) }, "rdap bootstrap not stored");
        return undefined;
    }
}

const isFresh = (entry: Stored): boolean => Date.now() - Date.parse(entry.fetched) < FRESH_MS;

// Fetches and stores the bootstrap; the caller holds the lock.
async function refresh(get: Get): Promise<Services> {
    const answer = await get(BOOTSTRAP, { headers: { accept: "application/json" } });
    if (answer.status !== 200) throw new Error(`the IANA RDAP bootstrap answered ${answer.status}`);
    const services = (JSON.parse(answer.body) as { services?: Services }).services ?? [];
    await writeAtomic(bootstrapFile(), JSON.stringify({ fetched: new Date().toISOString(), services }));
    log.info({ url: BOOTSTRAP, services: services.length }, "rdap bootstrap refreshed");
    return services;
}

// The bootstrap services from the user cache while under a day old, else refetched by one process under a file lock; a stale copy stands in when the refresh fails.
export async function bootstrap(get: Get): Promise<Services> {
    const cached = await stored();
    if (cached && isFresh(cached)) return cached.services;
    await mkdir(path.dirname(bootstrapFile()), { recursive: true });
    const release = await lockfile.lock(path.dirname(bootstrapFile()), { lockfilePath: `${bootstrapFile()}.lock`, realpath: false, stale: STALE_LOCK_MS, retries: { retries: 10, minTimeout: 200, maxTimeout: 2000, randomize: true } });
    try {
        const again = await stored();
        return again && isFresh(again) ? again.services : await refresh(get);
    } catch (error) {
        if (!cached) throw error;
        log.warn({ url: BOOTSTRAP, fetched: cached.fetched, error: reason(error) }, "rdap bootstrap refresh failed; using the stored copy");
        return cached.services;
    } finally {
        await release();
    }
}

// The RDAP base URL of the longest bootstrap suffix `domain` ends with, https preferred.
export function serverFor(domain: string, services: Services): string | undefined {
    const labels = domain.toLowerCase().split(".");
    for (let index = 1; index < labels.length; index += 1) {
        const suffix = labels.slice(index).join(".");
        const urls = services.find(([suffixes]) => suffixes.includes(suffix))?.[1];
        if (urls) return urls.find((url) => url.startsWith("https:")) ?? urls[0];
    }
    return undefined;
}

// A name server name lower-cased without its root dot.
export const nsName = (name: string): string => name.toLowerCase().replace(/\.$/, "");

// The status, expiration and name servers of `domain` from its registry’s RDAP server (RFC 9083); none when no server serves its TLD.
export async function registration(domain: string, get: Get): Promise<Registration | undefined> {
    const base = serverFor(domain, await bootstrap(get));
    log.debug({ domain, server: base }, "rdap server found");
    if (!base) return undefined;
    const url = new URL(`domain/${domain}`, base.endsWith("/") ? base : `${base}/`).href;
    const answer = await get(url, { headers: { accept: "application/rdap+json" }, redirect: "follow" });
    if (answer.status !== 200) throw new Error(`RDAP ${url} answered ${answer.status}`);
    const body = JSON.parse(answer.body) as { status?: unknown; events?: { eventAction?: string; eventDate?: string }[]; nameservers?: { ldhName?: string }[] };
    const expires = body.events?.find((event) => event.eventAction === "expiration")?.eventDate;
    const isDated = expires !== undefined && !Number.isNaN(Date.parse(expires));
    const nameservers = [...new Set((body.nameservers ?? []).flatMap((server) => (server.ldhName ? [nsName(server.ldhName)] : [])))].toSorted((a, b) => a.localeCompare(b));
    log.debug({ domain, url, status: body.status, expires, nameservers: nameservers.length }, "rdap answered");
    return { server: base, ...(Array.isArray(body.status) && { status: body.status.map((entry) => String(entry).toLowerCase()) }), ...(isDated && { expires: new Date(expires).toISOString() }), nameservers };
}
