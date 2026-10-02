// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { lockStore } from "../store/disk.ts";
import { log } from "../logger.ts";
import { bucketDirectory, type BucketName } from "./index.ts";
import { FILE_BUCKETS, files } from "./status.ts";

// Store directories that together make up the `pages` bucket.
const PAGES = ["datasets", "key_value_stores", "request_queues", "cache/pages", "manifest.json"];

export const PURGEABLE = new Set<string>(["pages", ...FILE_BUCKETS]);

// Deletes entries older than `olderThanSeconds` (all when 0) and returns how many went.
async function purgeFiles(directory: string, olderThanSeconds: number): Promise<number> {
    const cutoff = Date.now() - olderThanSeconds * 1000;
    const present = await files(directory);
    const stale = present.filter((file) => file.name.endsWith(".json") && file.mtime.getTime() <= cutoff);
    await Promise.all(stale.map((file) => rm(path.join(directory, file.name), { force: true })));
    return stale.length;
}

// The store manifest’s start, absent when there is no manifest.
async function readManifest(root: string): Promise<{ started?: string }> {
    try {
        return JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as { started?: string };
    } catch {
        return {};
    }
}

// A crawl’s pages are as old as the crawl, so `pages` goes whole once its manifest’s start passes the cutoff.
async function purgePages(root: string, olderThanSeconds: number): Promise<number> {
    const manifest = await readManifest(root);
    const isOld = !manifest.started || Date.now() - Date.parse(manifest.started) >= olderThanSeconds * 1000;
    log.debug({ root, started: manifest.started, olderThanSeconds, isOld }, "pages bucket aged");
    if (!isOld) return 0;
    const facts = await files(path.join(root, "datasets/facts"));
    const pages = facts.filter((file) => file.name.endsWith(".json")).length;
    await Promise.all(PAGES.map((entry) => rm(path.join(root, entry), { recursive: true, force: true })));
    return pages;
}

// Purges `bucket`, or every bucket, holding the store lock while project buckets are touched.
export async function purgeCache(root: string | undefined, bucket: string | undefined, olderThanSeconds: number): Promise<Record<string, number>> {
    const names = bucket === undefined ? [...PURGEABLE] : [bucket];
    const hasStore = root !== undefined && existsSync(root);
    const release = hasStore ? await lockStore(root as string) : undefined;
    const purged: Record<string, number> = {};
    try {
        for (const name of names) {
            const directory = bucketDirectory(name as BucketName, hasStore ? root : undefined);
            if (name === "pages") purged[name] = hasStore ? await purgePages(root as string, olderThanSeconds) : 0;
            else purged[name] = directory === undefined ? 0 : await purgeFiles(directory, olderThanSeconds);
            log.info({ bucket: name, purged: purged[name], olderThanSeconds }, `${purged[name]} entries purged from the ${name} cache`);
        }
    } finally {
        await release?.();
    }
    return purged;
}
