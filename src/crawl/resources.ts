// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { availableParallelism } from "node:os";
import { ExtractorCache } from "../cache/extractors.ts";
import { OfflineMiss, type Bucket } from "../cache/index.ts";
import { fetchCached, type Stored } from "../cache/http.ts";
import type { Config } from "../config/index.ts";
import type { Logged } from "./frontier.ts";
import { reason } from "./fetch.ts";
import { redactHeaders } from "../facts/transport.ts";
import type { Facts, ResourceFacts } from "../facts/types.ts";
import type { ResourceExtractor } from "../plugins/types.ts";
import type { ResourceResults } from "../store/disk.ts";
import { log } from "../logger.ts";

type ResourceHttp = NonNullable<ResourceFacts["http"]>;

// Pool width: `concurrency` when set, else NUMPROCS when the environment sets it, else the host's parallelism.
export function width(concurrency = 0): number {
    if (concurrency > 0) return concurrency;
    const numprocs = Number(process.env.NUMPROCS);
    return Number.isSafeInteger(numprocs) && numprocs > 0 ? numprocs : availableParallelism();
}

// Reads at most `max` body bytes, then cancels the rest; `isKept` also returns what it read.
async function drain(response: Response, max: number, isKept = false): Promise<{ bytes: number; body?: Uint8Array }> {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (isKept) chunks.push(value);
        if (bytes < max) continue;
        await reader.cancel();
        break;
    }
    return { bytes, ...(isKept && { body: Buffer.concat(chunks) }) };
}

// What the bucket keeps per URL: body bytes, the IDs of the extractors that read it, their facts and time.
export interface Consumed {
    bytes: number;
    read?: string[];
    facts?: Record<string, unknown>;
    ms?: number;
}

export type ResourceBucket = Bucket<Stored<Consumed>>;

// The media type of a content-type header, lower-cased.
function mediaType(raw: string | string[] | null | undefined): string {
    return String(raw ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

// Extractors that read a 2xx body of `contentType`.
function readers(extractors: ResourceExtractor[], status: number, contentType: string): ResourceExtractor[] {
    return status >= 200 && status < 300 ? extractors.filter((extractor) => extractor.types.some((type) => contentType.startsWith(type))) : [];
}

// Counts the body, and hands it whole to each extractor that reads its type.
async function consume(url: string, response: Response, max: number, extractors: ResourceExtractor[], cache: ExtractorCache): Promise<Consumed> {
    const contentType = mediaType(response.headers.get("content-type"));
    const { bytes, body } = await drain(response, max, readers(extractors, response.status, contentType).length > 0);
    return extractBody(url, response.status, contentType, bytes, body, max, extractors, cache);
}

// Hands a whole body to each extractor that reads its type, through `cache`; a body cut at `max` is read by none.
async function extractBody(url: string, status: number, contentType: string, bytes: number, body: Uint8Array | undefined, max: number, extractors: ResourceExtractor[], cache: ExtractorCache): Promise<Consumed> {
    const wanted = readers(extractors, status, contentType);
    const read = wanted.map((extractor) => extractor.id);
    if (!body || bytes >= max) {
        if (wanted.length > 0) log.debug({ url, bytes, max, extractors: read }, "resource body too large to extract");
        return { bytes, ...(wanted.length > 0 && { read }) };
    }
    const started = performance.now();
    const facts: Record<string, unknown> = {};
    for (const extractor of wanted) {
        try {
            const value = await cache.run(extractor, url, contentType, body, () => extractor.extract(url, contentType, body));
            if (value !== undefined) facts[extractor.id] = value;
        } catch (error) {
            log.warn({ url, extractor: extractor.id, error: error instanceof Error ? error.message : String(error) }, "resource extractor failed");
        }
    }
    const ms = Math.round(performance.now() - started);
    log.debug({ url, contentType, bytes, extractors: Object.keys(facts), ms }, "resource extracted");
    return { bytes, read, facts, ms };
}

// A stored answer every extractor now reading its type has already read.
function isServed(stored: Stored<Consumed>, extractors: ResourceExtractor[]): boolean {
    const read = new Set(stored.value.read);
    return readers(extractors, stored.status, mediaType(stored.headers["content-type"])).every((extractor) => read.has(extractor.id));
}

// One cached or retried GET; a final failure is status 0 with its error.
async function fetchOne(url: string, max: number, bucket: ResourceBucket, extractors: ResourceExtractor[], cache: ExtractorCache): Promise<ResourceResults[string]> {
    try {
        const { status, headers, value, ms, cached, revalidated } = await fetchCached(bucket, url, (response) => consume(url, response, max, extractors, cache), false, (stored) => isServed(stored, extractors));
        const { bytes, facts } = value;
        log.debug({ url, status, bytes, cached, revalidated }, "resource fetched");
        const contentType = mediaType(headers["content-type"]);
        const hasFacts = facts !== undefined && Object.keys(facts).length > 0;
        return { status, headers: redactHeaders(headers), ...(contentType && { contentType }), size: { body: bytes }, timing: { total: ms - (value.ms ?? 0) }, ...(cached && { cached }), ...(revalidated && { revalidated }), ...(hasFacts && { facts }) };
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        return { status: 0, headers: {}, size: { body: 0 }, timing: {}, error: reason(error) };
    }
}

// A logged answer that stands for a fetch: not a failure, nor a status a fetch would retry.
function isUsable(logged: Logged | undefined): logged is Logged {
    return logged !== undefined && logged.status >= 200 && logged.status < 500 && logged.status !== 429;
}

// A result from the browser’s network log, read by the same extractors a fetch would feed.
async function fromLog(url: string, logged: Logged, max: number, extractors: ResourceExtractor[], cache: ExtractorCache): Promise<ResourceResults[string]> {
    const contentType = mediaType(logged.headers["content-type"]);
    const { facts } = await extractBody(url, logged.status, contentType, logged.bytes, logged.body, max, extractors, cache);
    const hasFacts = facts !== undefined && Object.keys(facts).length > 0;
    log.debug({ url, status: logged.status, bytes: logged.bytes, hasBody: logged.body !== undefined }, "resource answered from the browser log");
    return { status: logged.status, headers: redactHeaders(logged.headers), ...(contentType && { contentType }), size: { body: logged.bytes }, timing: { ...(logged.ms !== undefined && { total: logged.ms }) }, logged: true, ...(hasFacts && { facts }) };
}

// Hangs each fetched result off every page entry that names its URL.
export function attachResources(pages: Facts[], results: ResourceResults): void {
    const entries = pages.flatMap((page) => page.resources ?? []);
    for (const entry of entries) {
        const { facts, ...http } = results[entry.url] ?? {};
        entry.http = results[entry.url] && (http as ResourceHttp);
        Object.assign(entry, facts);
    }
}

// GETs every distinct resource URL the pages name that `logged` lacks, once each, with `extractors` reading the bodies of their types through `cache`.
export async function fetchResources(pages: Facts[], config: Config, bucket: ResourceBucket, extractors: ResourceExtractor[] = [], logged = new Map<string, Logged>(), cache = new ExtractorCache(undefined)): Promise<ResourceResults> {
    const entries = pages.flatMap((page) => page.resources ?? []);
    const urls = [...new Set(entries.map((entry) => entry.url))];
    log.info({ resources: urls.length, references: entries.length, fetch: config.fetchResources }, "resources found");
    if (!config.fetchResources || urls.length === 0) return {};
    const results = new Map<string, ResourceResults[string]>();
    const queue = urls.values();
    const worker = async () => {
        for (const url of queue) {
            const answer = logged.get(url);
            results.set(url, isUsable(answer) ? await fromLog(url, answer, config.maxBodySize, extractors, cache) : await fetchOne(url, config.maxBodySize, bucket, extractors, cache));
        }
    };
    const workers = Array.from({ length: Math.min(width(config.concurrency), urls.length) }, worker);
    await Promise.all(workers);
    const all = results.values().toArray();
    const [failed, cached, revalidated, fromBrowser] = [all.filter((result) => result.status === 0).length, all.filter((result) => result.cached).length, all.filter((result) => result.revalidated).length, all.filter((result) => result.logged).length];
    log.info({ resources: urls.length, failed, cached, revalidated, logged: fromBrowser }, "resources fetched");
    return Object.fromEntries(results);
}
