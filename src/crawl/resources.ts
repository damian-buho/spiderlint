// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { availableParallelism } from "node:os";
import { OfflineMiss, type Bucket } from "../cache/index.ts";
import { fetchCached, type Stored } from "../cache/http.ts";
import type { Config } from "../config/index.ts";
import { reason } from "./fetch.ts";
import { redactHeaders } from "../facts/transport.ts";
import type { Facts, ResourceFacts } from "../facts/types.ts";
import type { ResourceResults } from "../store/disk.ts";
import { log } from "../logger.ts";

type ResourceHttp = NonNullable<ResourceFacts["http"]>;

// Pool width: NUMPROCS when the environment sets it, else the host's parallelism.
export function width(): number {
    const numprocs = Number(process.env.NUMPROCS);
    return Number.isSafeInteger(numprocs) && numprocs > 0 ? numprocs : availableParallelism();
}

// Reads at most `max` body bytes, then cancels the rest.
async function drain(response: Response, max: number): Promise<number> {
    let bytes = 0;
    const reader = response.body?.getReader();
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes < max) continue;
        await reader.cancel();
        break;
    }
    return bytes;
}

export type ResourceBucket = Bucket<Stored<number>>;

// One cached or retried GET; a final failure is status 0 with its error.
async function fetchOne(url: string, max: number, bucket: ResourceBucket): Promise<ResourceHttp> {
    try {
        const { status, headers, value: bytes, ms, cached, revalidated } = await fetchCached(bucket, url, (response) => drain(response, max));
        log.debug({ url, status, bytes, cached, revalidated }, "resource fetched");
        const contentType = String(headers["content-type"] ?? "").split(";", 1)[0]?.trim();
        return { status, headers: redactHeaders(headers), ...(contentType && { contentType }), size: { body: bytes }, timing: { total: ms }, ...(cached && { cached }), ...(revalidated && { revalidated }) };
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        return { status: 0, headers: {}, size: { body: 0 }, timing: {}, error: reason(error) };
    }
}

// Hangs each fetched result off every page entry that names its URL.
export function attachResources(pages: Facts[], results: ResourceResults): void {
    const entries = pages.flatMap((page) => page.resources ?? []);
    for (const entry of entries) entry.http = results[entry.url];
}

// GETs every distinct resource URL the pages name, once each.
export async function fetchResources(pages: Facts[], config: Config, bucket: ResourceBucket): Promise<ResourceResults> {
    const entries = pages.flatMap((page) => page.resources ?? []);
    const urls = [...new Set(entries.map((entry) => entry.url))];
    log.info({ resources: urls.length, references: entries.length, fetch: config.fetchResources }, "resources found");
    if (!config.fetchResources || urls.length === 0) return {};
    const results = new Map<string, ResourceHttp>();
    const queue = urls.values();
    const worker = async () => {
        for (const url of queue) results.set(url, await fetchOne(url, config.maxBodySize, bucket));
    };
    const workers = Array.from({ length: Math.min(width(), urls.length) }, worker);
    await Promise.all(workers);
    const all = results.values().toArray();
    const [failed, cached, revalidated] = [all.filter((result) => result.status === 0).length, all.filter((result) => result.cached).length, all.filter((result) => result.revalidated).length];
    log.info({ resources: urls.length, failed, cached, revalidated }, "resources fetched");
    return Object.fromEntries(results);
}
