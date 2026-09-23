// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { log } from "../logger.ts";

export interface BucketStatus {
    bucket: string;
    entries: number;
    bytes: number;
    oldest?: string;
    newest?: string;
}

// Bucket name, the store subdirectories holding it, and the file extension that counts as one entry.
const BUCKETS: [string, string[], string][] = [
    ["pages", ["datasets/facts", "key_value_stores/bodies"], ".json"],
    ["records", ["key_value_stores/records"], ".json"],
    ["frontier", ["request_queues/frontier"], ".json"],
];

// Files directly under `directory`, empty when it does not exist.
async function files(directory: string): Promise<{ name: string; size: number; mtime: Date }[]> {
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

// Entries, bytes and age range of every bucket present in the store at `root`.
export async function cacheStatus(root: string): Promise<BucketStatus[]> {
    const out: BucketStatus[] = [];
    for (const [bucket, directories, entryExtension] of BUCKETS) {
        const [first = "", ...rest] = directories;
        const primary = await files(path.join(root, first));
        const counted = primary.filter((file) => file.name.endsWith(entryExtension) && !file.name.startsWith("__"));
        const others = await Promise.all(rest.map((directory) => files(path.join(root, directory))));
        const all = [...counted, ...others.flat()];
        const times = all.map((file) => file.mtime.getTime()).toSorted((a, b) => a - b);
        log.debug({ root, bucket, entries: counted.length, files: all.length }, "bucket measured");
        if (all.length === 0) continue;
        out.push({ bucket, entries: counted.length, bytes: all.reduce((sum, file) => sum + file.size, 0), oldest: new Date(times[0] as number).toISOString(), newest: new Date(times.at(-1) as number).toISOString() });
    }
    return out;
}
