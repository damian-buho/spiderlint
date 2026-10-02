// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "../config/index.ts";
import { log } from "../logger.ts";

export type BucketName = "pages" | "probes" | "resources" | "robots" | "sitemaps" | "origins" | "dns" | "extractors";
export type CacheMode = "use" | "off" | "refresh" | "offline";

// Seconds each bucket stays fresh when the origin says nothing; `pages` 0 lets origin headers alone decide, `extractors` 0 keeps an entry until its body changes.
export const TTL_DEFAULTS: Record<BucketName, number> = { pages: 0, probes: 7 * 86_400, resources: 86_400, robots: 86_400, sitemaps: 86_400, origins: 86_400, dns: 60, extractors: 0 };

// Buckets beside the project; the rest hold third-party observations shared by every site on the machine.
const PROJECT = new Set<BucketName>(["pages", "resources", "sitemaps", "origins", "dns", "extractors"]);

export interface Entry<T> {
    key: string;
    stored: string;
    value: T;
}

// `--offline` found nothing stored for a key; the run exits 3.
export class OfflineMiss extends Error {}

// Write to a unique sibling temp file, then rename over the target.
export async function writeAtomic(file: string, content: string): Promise<void> {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, file);
}

// `$XDG_CACHE_HOME/spiderlint`, else `~/.cache/spiderlint`.
export function userCacheDirectory(): string {
    return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "spiderlint");
}

// `<user cache>/<host>` for the seeds’ hosts, `+`-joined when they span several; undefined without a seed.
export function siteDirectory(seeds: string[]): string | undefined {
    const hosts = [...new Set(seeds.filter((seed) => URL.canParse(seed)).map((seed) => new URL(seed).host))].toSorted((a, b) => a.localeCompare(b));
    return hosts.length === 0 ? undefined : path.join(userCacheDirectory(), hosts.join("+"));
}

// Where `name` lives: the store's `cache/` for project buckets, the user cache otherwise; none without a store.
export function bucketDirectory(name: BucketName, store: string | undefined): string | undefined {
    if (!PROJECT.has(name)) return path.join(userCacheDirectory(), name);
    return store === undefined ? undefined : path.join(store, "cache", name);
}

// One JSON file per key, named by the key's hash; `off` neither reads nor writes, `refresh` only writes.
export class Bucket<T> {
    readonly name: BucketName;
    readonly directory: string | undefined;
    readonly ttlSeconds: number;
    readonly mode: CacheMode;

    constructor(name: BucketName, directory: string | undefined, ttlSeconds: number, mode: CacheMode) {
        this.name = name;
        this.directory = directory;
        this.ttlSeconds = ttlSeconds;
        this.mode = mode;
    }

    #file(key: string): string {
        return path.join(this.directory as string, `${createHash("sha256").update(key).digest("hex")}.json`);
    }

    // The stored entry for `key`, however old.
    async get(key: string): Promise<Entry<T> | undefined> {
        if (this.directory === undefined || this.mode === "off" || this.mode === "refresh") return undefined;
        let entry: Entry<T>;
        try {
            entry = JSON.parse(await readFile(this.#file(key), "utf8")) as Entry<T>;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") log.warn({ bucket: this.name, key, error: error instanceof Error ? error.message : String(error) }, `${this.name} cache entry unreadable and ignored:`);
            log.debug({ bucket: this.name, key }, "cache miss");
            return undefined;
        }
        if (entry.key !== key) return undefined;
        log.debug({ bucket: this.name, key, stored: entry.stored }, "cache hit");
        return entry;
    }

    // Younger than the bucket TTL.
    isFresh(entry: Entry<T>): boolean {
        return Date.now() - Date.parse(entry.stored) < this.ttlSeconds * 1000;
    }

    async set(key: string, value: T): Promise<void> {
        if (this.directory === undefined || this.mode === "off" || this.mode === "offline") return;
        await mkdir(this.directory, { recursive: true });
        const entry: Entry<T> = { key, stored: new Date().toISOString(), value };
        await writeAtomic(this.#file(key), JSON.stringify(entry));
        log.debug({ bucket: this.name, key }, "cache stored");
    }

    // A miss under `--offline` ends the run.
    missed(key: string): void {
        if (this.mode === "offline") throw new OfflineMiss(`--offline: ${this.name} holds nothing for ${key}`);
    }
}

// The bucket `name` for this run, located and timed from the config.
export function openBucket<T>(name: BucketName, config: Pick<Config, "cacheMode" | "cacheTtl">, store: string | undefined): Bucket<T> {
    return new Bucket<T>(name, bucketDirectory(name, store), config.cacheTtl[name] ?? TTL_DEFAULTS[name], config.cacheMode);
}

// `90`, `45s`, `30m`, `24h`, `7d` to seconds.
export function parseDuration(raw: string | number): number | undefined {
    const match = /^(\d+)([smhd]?)$/.exec(String(raw).trim());
    return match ? Number(match[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86_400 }[match[2] as "" | "s" | "m" | "h" | "d"] : undefined;
}
