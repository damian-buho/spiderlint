// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Configuration, Dataset, KeyValueStore, RequestQueue } from "crawlee";
import lockfile from "proper-lockfile";
import { VERSION } from "../agent.ts";
import { ConfigError } from "../config/index.ts";
import type { Facts, ResourceFacts, SiteFacts } from "../facts/types.ts";
import type { Summary } from "../index.ts";
import { log, logRelativeTo } from "../logger.ts";
import type { Finding } from "../rules/types.ts";

export interface Manifest {
    version: string;
    seeds: string[];
    configHash: string;
    started: string;
    finished?: string;
}

export type ResourceResults = Record<string, NonNullable<ResourceFacts["http"]>>;

export interface StoredReport {
    findings: Finding[];
    summary: Summary;
}

const RESOURCES = "resources";
const REPORT = "report";
const SITE = "site";

function key(url: string): string {
    return createHash("sha256").update(url).digest("hex");
}

type Storages = [Dataset, KeyValueStore, KeyValueStore, RequestQueue];

async function openStorages(config: Configuration): Promise<Storages> {
    return [await Dataset.open("facts", { config }), await KeyValueStore.open("bodies", { config }), await KeyValueStore.open("records", { config }), await RequestQueue.open("frontier", { config })];
}

// Write to a sibling temp file, then rename over the target.
async function writeAtomic(file: string, content: string): Promise<void> {
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, file);
}

// The `pages` bucket: facts in a Dataset, bodies and results in KeyValueStores, the frontier in a RequestQueue.
export class DiskStore {
    // Locks `directory`; a fresh crawl empties it, a resumed crawl or a re-lint keeps it.
    static async open(directory: string, mode: { fresh: boolean; seeds?: string[]; configHash?: string }): Promise<DiskStore> {
        await mkdir(directory, { recursive: true });
        let release: () => Promise<void>;
        try {
            release = await lockfile.lock(directory, { lockfilePath: path.join(directory, "manifest.json.lock"), realpath: false, retries: 0, stale: 30_000, update: 10_000 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ConfigError(`store ${directory} is in use by another process`);
            throw error;
        }
        const config = new Configuration({ storageClientOptions: { localDataDirectory: directory }, persistStorage: true, purgeOnStart: false });
        const previous = await DiskStore.#readManifest(directory);
        let storages = await openStorages(config);
        if (mode.fresh) {
            await Promise.all(storages.map((storage) => storage.drop()));
            storages = await openStorages(config);
        }
        const { configHash, fresh, seeds = [] } = mode;
        if (previous && configHash && previous.configHash !== configHash) log.warn({ directory, stored: previous.configHash, current: configHash }, "store was crawled with another configuration");
        const manifest: Manifest = fresh || !previous ? { version: VERSION, seeds, configHash: configHash ?? "", started: new Date().toISOString() } : previous;
        const store = new DiskStore(directory, config, storages, release, manifest);
        await store.#writeManifest();
        log.info({ directory, fresh: mode.fresh, started: manifest.started }, "store opened");
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
    readonly frontier: RequestQueue;
    readonly manifest: Manifest;

    private constructor(directory: string, config: Configuration, storages: Storages, release: () => Promise<void>, manifest: Manifest) {
        this.directory = directory;
        this.config = config;
        this.facts = storages[0];
        this.bodies = storages[1];
        this.records = storages[2];
        this.frontier = storages[3];
        this.#release = release;
        this.manifest = manifest;
    }

    async #writeManifest(): Promise<void> {
        await writeAtomic(path.join(this.directory, "manifest.json"), `${JSON.stringify(this.manifest, undefined, 2)}\n`);
    }

    async add(facts: Facts, body: string): Promise<void> {
        await this.facts.pushData(facts);
        await this.bodies.setValue(key(facts.url.href), body, { contentType: facts.http.contentType || "application/octet-stream" });
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
        log.info({ directory: this.directory, finished: this.manifest.finished }, "store closed");
    }
}
