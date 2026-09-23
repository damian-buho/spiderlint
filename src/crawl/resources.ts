// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { availableParallelism } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { USER_AGENT } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { redactHeaders } from "../facts/transport.ts";
import type { Facts, ResourceFacts } from "../facts/types.ts";
import type { ResourceResults } from "../store/disk.ts";
import { log } from "../logger.ts";

type ResourceHttp = NonNullable<ResourceFacts["http"]>;

const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 503]);

// Pool width: NUMPROCS when the environment sets it, else the host's parallelism.
function width(): number {
    const numprocs = Number(process.env.NUMPROCS);
    return Number.isSafeInteger(numprocs) && numprocs > 0 ? numprocs : availableParallelism();
}

// Exponential backoff with jitter; a Retry-After in seconds wins, capped at the timeout.
function delay(attempt: number, retryAfter?: string): number {
    const seconds = Number(retryAfter ?? NaN);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, TIMEOUT_MS) : 500 * 2 ** attempt + Math.random() * 250;
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

// One GET with timeout, retries on network errors, 429 and 503; a final failure is status 0 with its error.
async function fetchOne(url: string, max: number): Promise<ResourceHttp> {
    let failure = "";
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const started = performance.now();
        try {
            const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            const bytes = await drain(response, max);
            const isLast = attempt === ATTEMPTS - 1;
            log.debug({ url, status: response.status, bytes, attempt }, "resource fetched");
            if (!isLast && RETRY_STATUS.has(response.status)) {
                await sleep(delay(attempt, response.headers.get("retry-after") ?? undefined));
                continue;
            }
            const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
            return { status: response.status, headers: redactHeaders(Object.fromEntries(response.headers)), ...(contentType && { contentType }), size: { body: bytes }, timing: { total: Math.round(performance.now() - started) } };
        } catch (error) {
            failure = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
            log.debug({ url, attempt, error: failure }, "resource fetch failed");
            if (attempt < ATTEMPTS - 1) await sleep(delay(attempt));
        }
    }
    return { status: 0, headers: {}, size: { body: 0 }, timing: {}, error: failure };
}

// Hangs each fetched result off every page entry that names its URL.
export function attachResources(pages: Facts[], results: ResourceResults): void {
    const entries = pages.flatMap((page) => page.resources ?? []);
    for (const entry of entries) entry.http = results[entry.url];
}

// GETs every distinct resource URL the pages name, once each.
export async function fetchResources(pages: Facts[], config: Config): Promise<ResourceResults> {
    const entries = pages.flatMap((page) => page.resources ?? []);
    const urls = [...new Set(entries.map((entry) => entry.url))];
    log.info({ resources: urls.length, references: entries.length, fetch: config.fetchResources }, "resources found");
    if (!config.fetchResources || urls.length === 0) return {};
    const results = new Map<string, ResourceHttp>();
    const queue = urls.values();
    const worker = async () => {
        for (const url of queue) results.set(url, await fetchOne(url, config.maxBodySize));
    };
    const workers = Array.from({ length: Math.min(width(), urls.length) }, worker);
    await Promise.all(workers);
    const failed = results.values().filter((result) => result.status === 0).toArray().length;
    log.info({ resources: urls.length, failed }, "resources fetched");
    return Object.fromEntries(results);
}
