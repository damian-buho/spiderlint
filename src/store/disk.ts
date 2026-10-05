// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { Configuration, Dataset, KeyValueStore, RequestQueue } from "crawlee";
import lockfile from "proper-lockfile";
import { VERSION } from "../agent.ts";
import { writeAtomic } from "../cache/index.ts";
import { ConfigError } from "../config/index.ts";
import type { Facts, ResourceFacts, SiteFacts } from "../facts/types.ts";
import type { Summary } from "../index.ts";
import { log, logRelativeTo } from "../logger.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";

export interface Manifest {
    version: string;
    seeds: string[];
    configHash: string;
    started: string;
    finished?: string;
}

// Each resource URL’s answer, with its resource extractors’ facts by ID.
export type ResourceResults = Record<string, NonNullable<ResourceFacts["http"]> & { facts?: Record<string, unknown> }>;

export interface StoredReport {
    findings: Finding[];
    summary: Summary;
    rules?: Record<string, RuleGuide>;
}

const RESOURCES = "resources";
const REPORT = "report";
const SITE = "site";
// Crawlee hands a text/plain record back verbatim; a page’s own type would parse JSON into an object.
const BODY_TYPE = "text/plain; charset=utf-8";

function key(url: string): string {
    return createHash("sha256").update(url).digest("hex");
}

type Storages = [Dataset, KeyValueStore, KeyValueStore, RequestQueue, RequestQueue];

async function openStorages(config: Configuration): Promise<Storages> {
    return [await Dataset.open("facts", { config }), await KeyValueStore.open("bodies", { config }), await KeyValueStore.open("records", { config }), await RequestQueue.open("frontier", { config }), await RequestQueue.open("frontier-browser", { config })];
}

// `lint` or `show-report` found no stored crawl; the run exits 3.
export class NothingStored extends Error {}

const STALE_MS = 30_000;

interface Holder {
    pid: number;
    host: string;
}

// The lock holder the pid file names, when it is readable.
async function readHolder(holderPath: string): Promise<Holder | undefined> {
    try {
        return JSON.parse(await readFile(holderPath, "utf8")) as Holder;
    } catch {
        return undefined;
    }
}

// Whether the process that wrote `holder` is gone; one on another host is presumed alive.
function isGone(holder: Holder | undefined): boolean {
    if (!holder || holder.host !== hostname()) return false;
    try {
        process.kill(holder.pid, 0);
        return false;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
}

// Holds the store at `directory` for this process; a live second holder is a ConfigError, a dead one’s lock is waited out until stale.
export async function lockStore(directory: string): Promise<() => Promise<void>> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockfilePath = path.join(directory, "manifest.json.lock");
    const holderPath = `${lockfilePath}.pid`;
    const options = { lockfilePath, realpath: false, stale: STALE_MS, update: STALE_MS / 3 };
    let release: () => Promise<void>;
    try {
        release = await lockfile.lock(directory, { ...options, retries: 0 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
        const holder = await readHolder(holderPath);
        const isDead = isGone(holder);
        log.debug({ directory, holder, isDead }, "store lock held");
        if (!isDead) throw new ConfigError(`store ${directory} is in use by ${holder ? `process ${holder.pid} on ${holder.host}` : "another process"}`);
        log.warn({ directory, holder: holder?.pid, staleSeconds: STALE_MS / 1000 }, `store ${directory} locked by process ${holder?.pid}, which is gone; waiting ${STALE_MS / 1000} s for the lock to go stale`);
        try {
            release = await lockfile.lock(directory, { ...options, retries: { retries: STALE_MS / 1000 + 5, factor: 1, minTimeout: 1000, maxTimeout: 1000 } });
        } catch (error_) {
            if ((error_ as NodeJS.ErrnoException).code === "ELOCKED") throw new ConfigError(`store ${directory} was taken by another process`);
            throw error_;
        }
    }
    await writeAtomic(holderPath, JSON.stringify({ pid: process.pid, host: hostname() } satisfies Holder));
    return release;
}

// The `pages` bucket: facts in a Dataset, bodies and results in KeyValueStores, the frontier in a RequestQueue.
export class DiskStore {
    // Locks `directory`; a fresh crawl empties it, a resumed crawl or a re-lint keeps it, and `existing` refuses one never written.
    static async open(directory: string, mode: { fresh: boolean; existing?: boolean; seeds?: string[]; configHash?: string }): Promise<DiskStore> {
        const isStored = existsSync(path.join(directory, "manifest.json"));
        log.debug({ directory, existing: mode.existing, isStored }, "store looked up");
        if (!isStored && mode.existing) throw new NothingStored(`nothing stored in ${directory}; run spiderlint audit or crawl first`);
        const release = await lockStore(directory);
        const config = new Configuration({ storageClientOptions: { localDataDirectory: directory }, persistStorage: true, purgeOnStart: false });
        const previous = await DiskStore.#readManifest(directory);
        let storages = await openStorages(config);
        const lastReport = await storages[2].getValue<StoredReport>(REPORT);
        const last = lastReport?.summary;
        const earlier = new Map<string, Facts>();
        if (mode.fresh) {
            const stored = await storages[0].map((item) => item as unknown as Facts);
            for (const facts of stored) for (const href of [facts.url.href, facts.crawl.requested]) if (href) earlier.set(href, facts);
            const crawlerState = await KeyValueStore.open(undefined, { config });
            const [facts, , records, frontier, rendering] = storages;
            await Promise.all([facts, records, frontier, rendering, crawlerState].map((storage) => storage.drop()));
            storages = await openStorages(config);
        }
        const { configHash, fresh, seeds = [] } = mode;
        if (previous && configHash && previous.configHash !== configHash) log.warn({ directory, stored: previous.configHash, current: configHash }, "store was crawled with another configuration");
        const manifest: Manifest = fresh || !previous ? { version: VERSION, seeds, configHash: configHash ?? "", started: new Date().toISOString() } : previous;
        const store = new DiskStore(directory, config, storages, release, manifest, earlier, last ?? undefined);
        await store.#writeManifest();
        log.info({ directory, fresh: mode.fresh, started: manifest.started, earlier: earlier.size }, earlier.size > 0 ? `resuming ${earlier.size} pages stored in ${directory}` : `pages stored in ${directory}`);
        logRelativeTo(manifest.seeds);
        return store;
    }

    static async #readManifest(directory: string): Promise<Manifest | undefined> {
        try {
            return JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new ConfigError(`store ${directory}: unreadable manifest.json (${error instanceof Error ? error.message : String(error)})`);
        }
    }

    readonly #release: () => Promise<void>;
    readonly directory: string;
    readonly config: Configuration;
    readonly facts: Dataset;
    readonly bodies: KeyValueStore;
    readonly records: KeyValueStore;
    // One frontier per crawler, so a resumed run hands each its own.
    readonly frontiers: { http: RequestQueue; browser: RequestQueue };
    readonly manifest: Manifest;
    readonly earlier: Map<string, Facts>;
    readonly last?: Summary;

    private constructor(directory: string, config: Configuration, storages: Storages, release: () => Promise<void>, manifest: Manifest, earlier: Map<string, Facts>, last?: Summary) {
        this.earlier = earlier;
        if (last) this.last = last;
        this.directory = directory;
        this.config = config;
        this.facts = storages[0];
        this.bodies = storages[1];
        this.records = storages[2];
        this.frontiers = { http: storages[3], browser: storages[4] };
        this.#release = release;
        this.manifest = manifest;
    }

    async #writeManifest(): Promise<void> {
        await writeAtomic(path.join(this.directory, "manifest.json"), `${JSON.stringify(this.manifest, undefined, 2)}\n`);
    }

    async add(facts: Facts, body: string): Promise<void> {
        await this.facts.pushData(facts);
        await this.bodies.setValue(key(facts.url.href), body, { contentType: BODY_TYPE });
    }

    // A page’s stored body, which a fresh crawl keeps for revalidation; one that reads back as neither text nor bytes is a miss.
    async body(href: string): Promise<string | undefined> {
        const value = await this.bodies.getValue<unknown>(key(href));
        if (value === null || value === undefined || typeof value === "string") return value ?? undefined;
        if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
        log.warn({ url: href, type: typeof value }, "stored body unreadable, page fetched in full");
        return undefined;
    }

    // Deletes the bodies of pages this crawl no longer has.
    async pruneBodies(pages: Facts[]): Promise<number> {
        const keep = new Set(pages.map((page) => key(page.url.href)));
        const gone: string[] = [];
        await this.bodies.forEachKey((name) => {
            if (!keep.has(name)) gone.push(name);
        });
        // eslint-disable-next-line unicorn/no-null -- Crawlee deletes a record when its value is null
        for (const name of gone) await this.bodies.setValue(name, null);
        log.debug({ kept: keep.size, pruned: gone.length }, "bodies pruned");
        return gone.length;
    }

    async pages(): Promise<Facts[]> {
        return this.facts.map((item) => item as unknown as Facts);
    }

    async saveResources(results: ResourceResults): Promise<void> {
        await this.records.setValue(RESOURCES, results);
    }

    async resources(): Promise<ResourceResults> {
        return (await this.records.getValue<ResourceResults>(RESOURCES)) ?? {};
    }

    async saveSite(site: SiteFacts): Promise<void> {
        await this.records.setValue(SITE, site);
    }

    async site(): Promise<SiteFacts> {
        return (await this.records.getValue<SiteFacts>(SITE)) ?? { sitemaps: [] };
    }

    async saveReport(report: StoredReport): Promise<void> {
        await this.records.setValue(REPORT, report);
    }

    async report(): Promise<StoredReport> {
        const report = await this.records.getValue<StoredReport>(REPORT);
        if (!report) throw new ConfigError(`store ${this.directory} holds no report; run spiderlint lint --store ${this.directory} first`);
        return report;
    }

    // Stamps `finished` and releases the lock.
    async close(isFinished: boolean): Promise<void> {
        if (isFinished) this.manifest.finished = new Date().toISOString();
        await this.#writeManifest();
        await this.#release();
        log.debug({ directory: this.directory, finished: this.manifest.finished }, "store closed");
    }
}
