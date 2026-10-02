// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { availableParallelism } from "node:os";
import { ExtractorCache } from "../cache/extractors.ts";
import { Bucket, OfflineMiss } from "../cache/index.ts";
import { fetchCached, type Stored } from "../cache/http.ts";
import type { Config } from "../config/index.ts";
import type { Logged } from "./frontier.ts";
import { attemptsFor, MISMATCH, reason } from "./fetch.ts";
import { cookieFacts, redactHeaders } from "../facts/transport.ts";
import type { Facts, ResourceFacts } from "../facts/types.ts";
import type { ResourceExtractor } from "../plugins/types.ts";
import type { ResourceResults } from "../store/disk.ts";
import { log } from "../logger.ts";

type ResourceHttp = NonNullable<ResourceFacts["http"]>;

// The Accept header Chromium sends for an image, so an origin negotiating AVIF or WebP answers as it would a browser.
const IMAGE_ACCEPT = { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" };

// The codings Chromium accepts, so an origin compressing in br or zstd alone answers as it would a browser.
const ACCEPT_ENCODING = { "accept-encoding": "gzip, deflate, br, zstd" };

// Pool width: `concurrency` when set, else NUMPROCS when the environment sets it, else the host's parallelism.
export function width(concurrency = 0): number {
    if (concurrency > 0) return concurrency;
    const numprocs = Number(process.env.NUMPROCS);
    return Number.isSafeInteger(numprocs) && numprocs > 0 ? numprocs : availableParallelism();
}

// The next body chunk; a read failing short of `Content-Length` names both byte counts.
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>, response: Response, bytes: number): Promise<ReadableStreamReadResult<Uint8Array>> {
    try {
        return await reader.read();
    } catch (error) {
        const declared = Number(response.headers.get("content-length"));
        log.debug({ url: response.url, bytes, declared, error: String(error) }, "resource body cut off");
        throw bytes < declared ? new Error(`${MISMATCH}: body ended at ${bytes} of the ${declared} bytes Content-Length declares`) : error;
    }
}

// Reads at most `max` body bytes, then cancels the rest; `isKept` also returns what it read.
async function drain(response: Response, max: number, isKept = false): Promise<{ bytes: number; body?: Uint8Array }> {
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    while (reader) {
        const { done, value } = await readChunk(reader, response, bytes);
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
            log.warn({ url, extractor: extractor.id, error: error instanceof Error ? error.message : String(error) }, `${extractor.id} checks skipped on`);
        }
    }
    const ms = Math.round(performance.now() - started);
    log.debug({ url, contentType, bytes, extractors: Object.keys(facts), ms }, "resource extracted");
    return { bytes, read, facts, ms };
}

// A failed answer kept in the `resources` bucket until `until`, so the next run does not pay its retries again.
interface Failure {
    status: number;
    error?: string;
    attempts: number;
    until: string;
}

type FailureBucket = Bucket<Failure>;

// The failure entry key, beside the URL’s own answer.
const failureKey = (url: string) => `failed\t${url}`;

// A 5xx or no answer at all.
export function isFailure(status: number): boolean {
    return status === 0 || status >= 500;
}

// Seconds a `Retry-After` in seconds or as an HTTP date asks for, else `fallback`.
function retryAfter(raw: string | string[] | undefined, fallback: number): number {
    const value = [raw].flat()[0]?.trim();
    if (!value) return fallback;
    const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : fallback;
}

// The stored failure for `url` while it is younger than its `until`, or any under `--offline`.
async function storedFailure(url: string, failures: FailureBucket): Promise<ResourceResults[string] | undefined> {
    const entry = await failures.get(failureKey(url));
    const isFresh = entry !== undefined && (failures.mode === "offline" || Date.now() < Date.parse(entry.value.until));
    log.debug({ url, status: entry?.value.status, until: entry?.value.until, isFresh }, "resource failure looked up");
    if (!entry || !isFresh) return undefined;
    const { status, error } = entry.value;
    return { status, headers: {}, size: { body: 0 }, timing: {}, ...(error && { error }), cached: true };
}

// Keeps a failed `result` for its `Retry-After`, else `ttl` seconds.
async function storeFailure(url: string, result: ResourceResults[string], failures: FailureBucket, ttl: number): Promise<void> {
    const seconds = retryAfter(result.headers["retry-after"], ttl);
    const failure: Failure = { status: result.status, ...(result.error && { error: result.error }), attempts: attemptsFor(result.status), until: new Date(Date.now() + seconds * 1000).toISOString() };
    log.debug({ url, ...failure, seconds }, "resource failure stored");
    await failures.set(failureKey(url), failure);
}

// A stored answer every extractor now reading its type has already read.
function isServed(stored: Stored<Consumed>, extractors: ResourceExtractor[]): boolean {
    const read = new Set(stored.value.read);
    return readers(extractors, stored.status, mediaType(stored.headers["content-type"])).every((extractor) => read.has(extractor.id));
}

// A GET through the stored failure first; a fresh 5xx or unreachable answer is served, a new one stored.
async function fetchRemembered(url: string, config: Config, bucket: ResourceBucket, failures: FailureBucket, extractors: ResourceExtractor[], cache: ExtractorCache, sent: Record<string, string>): Promise<ResourceResults[string]> {
    const stored = await storedFailure(url, failures);
    if (stored) return stored;
    const result = await fetchOne(url, config.maxBodySize, bucket, extractors, cache, sent);
    if (isFailure(result.status)) await storeFailure(url, result, failures, config.cacheFailureTtl);
    return result;
}

// One cached or retried GET with `sent` headers; a final failure is status 0 with its error.
async function fetchOne(url: string, max: number, bucket: ResourceBucket, extractors: ResourceExtractor[], cache: ExtractorCache, sent: Record<string, string>): Promise<ResourceResults[string]> {
    try {
        const { status, headers, value, ms, cached, revalidated } = await fetchCached(bucket, url, (response) => consume(url, response, max, extractors, cache), false, (stored) => isServed(stored, extractors), sent);
        const { bytes, facts } = value;
        log.debug({ url, status, bytes, cached, revalidated }, "resource fetched");
        const contentType = mediaType(headers["content-type"]);
        const hasFacts = facts !== undefined && Object.keys(facts).length > 0;
        const cookies = cookieFacts(headers["set-cookie"], headers.date);
        return { status, headers: redactHeaders(headers), ...(contentType && { "content-type": contentType }), size: { body: bytes }, timing: { total: ms - (value.ms ?? 0) }, ...(cookies.length > 0 && { cookies }), ...(cached && { cached }), ...(revalidated && { revalidated }), ...(hasFacts && { facts }) };
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
    const cookies = cookieFacts(logged.headers["set-cookie"], logged.headers.date);
    log.debug({ url, status: logged.status, bytes: logged.bytes, hasBody: logged.body !== undefined, cookies: cookies.length }, "resource answered from the browser log");
    return { status: logged.status, headers: redactHeaders(logged.headers), ...(contentType && { "content-type": contentType }), size: { body: logged.bytes }, timing: { ...(logged.ms !== undefined && { total: logged.ms }) }, ...(cookies.length > 0 && { cookies }), logged: true, ...(hasFacts && { facts }) };
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
    const images = new Set(entries.filter((entry) => entry.kind === "image").map((entry) => entry.url));
    log.debug({ resources: urls.length, references: entries.length, images: images.size, fetch: config.fetchResources }, "resources found");
    if (!config.fetchResources || urls.length === 0) return {};
    const results = new Map<string, ResourceResults[string]>();
    const failures = new Bucket<Failure>(bucket.name, bucket.directory, bucket.ttlSeconds, bucket.mode);
    const queue = urls.values();
    const worker = async () => {
        for (const url of queue) {
            const answer = logged.get(url);
            results.set(url, isUsable(answer) ? await fromLog(url, answer, config.maxBodySize, extractors, cache) : await fetchRemembered(url, config, bucket, failures, extractors, cache, { ...ACCEPT_ENCODING, ...(images.has(url) && IMAGE_ACCEPT) }));
        }
    };
    const workers = Array.from({ length: Math.min(width(config.concurrency), urls.length) }, worker);
    await Promise.all(workers);
    const all = results.values().toArray();
    const [failed, cached, revalidated, fromBrowser] = [all.filter((result) => result.status === 0).length, all.filter((result) => result.cached).length, all.filter((result) => result.revalidated).length, all.filter((result) => result.logged).length];
    const failedCached = all.filter((result) => result.cached && isFailure(result.status)).length;
    log.debug({ resources: urls.length, failed, cached, failedCached, revalidated, logged: fromBrowser }, "resources fetched");
    return Object.fromEntries(results);
}
