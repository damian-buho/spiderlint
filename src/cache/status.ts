// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.ts";
import { bucketDirectory, type BucketName } from "./index.ts";

export interface BucketStatus {
    bucket: string;
    entries: number;
    bytes: number;
    oldest?: string;
    newest?: string;
}

// Buckets kept as one JSON file per key.
export const FILE_BUCKETS: BucketName[] = ["resources", "sitemaps", "robots", "origins"];

// Bucket name, the directories holding it (entries counted in the first), and the extension of one entry; user buckets only without a store.
function layout(root: string | undefined): [string, string[], string][] {
    const files = FILE_BUCKETS.filter((name) => bucketDirectory(name, root)).map((name): [string, string[], string] => [name, [bucketDirectory(name, root) as string], ".json"]);
    return root === undefined ? files : [
        ["pages", [path.join(root, "datasets/facts"), path.join(root, "key_value_stores/bodies"), bucketDirectory("pages", root) as string], ".json"],
        ["records", [path.join(root, "key_value_stores/records")], ".json"],
        ["frontier", [path.join(root, "request_queues/frontier")], ".json"],
        ...files,
    ];
}

// Files directly under `directory`, empty when it does not exist.
export async function files(directory: string): Promise<{ name: string; size: number; mtime: Date }[]> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return [];
    }
    return Promise.all(
        names.map(async (name) => {
            const { size, mtime } = await stat(path.join(directory, name));
            return { name, size, mtime };
        }),
    );
}

// Entries, bytes and age range of every bucket present for the store at `root` and in the user cache.
export async function cacheStatus(root: string | undefined): Promise<BucketStatus[]> {
    const out: BucketStatus[] = [];
    for (const [bucket, directories, entryExtension] of layout(root)) {
        const [first = "", ...rest] = directories;
        const primary = await files(first);
        const counted = primary.filter((file) => file.name.endsWith(entryExtension) && !file.name.startsWith("__"));
        const others = await Promise.all(rest.map((directory) => files(directory)));
        const all = [...counted, ...others.flat()];
        const times = all.map((file) => file.mtime.getTime()).toSorted((a, b) => a - b);
        log.debug({ root, bucket, entries: counted.length, files: all.length }, "bucket measured");
        if (all.length === 0) continue;
        out.push({ bucket, entries: counted.length, bytes: all.reduce((sum, file) => sum + file.size, 0), oldest: new Date(times[0] as number).toISOString(), newest: new Date(times.at(-1) as number).toISOString() });
    }
    return out;
}
