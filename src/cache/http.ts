// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import CachePolicy from "http-cache-semantics";
import { USER_AGENT } from "../agent.ts";
import { fetchRetrying } from "../crawl/fetch.ts";
import { redactHeaders } from "../facts/transport.ts";
import { log } from "../logger.ts";
import type { Bucket, Entry } from "./index.ts";

type Headers = Record<string, string | string[]>;

export interface Stored<T> {
    policy: CachePolicy.CachePolicyObject;
    status: number;
    headers: Headers;
    value: T;
    ms: number;
}

export interface Served<T> {
    status: number;
    headers: Headers;
    value: T;
    ms: number;
    cached?: true;
    revalidated?: true;
}

// A private cache, and no heuristic freshness: an origin that says nothing gets the bucket TTL instead.
const OPTIONS = { shared: false, cacheHeuristic: 0 };

const REQUEST = (url: string, headers: Record<string, string> = {}): CachePolicy.HttpRequest => ({ url, method: "GET", headers: { ...headers, "user-agent": USER_AGENT } });

// No `Cache-Control` and no `Expires`: the origin states no freshness.
function isSilent(headers: Headers): boolean {
    return headers["cache-control"] === undefined && headers.expires === undefined;
}

// Policy, headers and value as written to the bucket, with secrets redacted.
function toStored<T>(policy: CachePolicy, status: number, headers: Headers, value: T, ms: number): Stored<T> {
    const object = policy.toObject();
    return { policy: { ...object, resh: redactHeaders(object.resh) }, status, headers: redactHeaders(headers), value, ms };
}

// Fresh by the origin’s headers, or by the bucket TTL when they are silent or `isCapped`; everything is fresh offline.
function isFresh<T>(bucket: Bucket<Stored<T>>, entry: Entry<Stored<T>>, policy: CachePolicy, isCapped: boolean, request: CachePolicy.HttpRequest): boolean {
    if (bucket.mode === "offline") return true;
    return isSilent(entry.value.headers) ? bucket.isFresh(entry) : policy.satisfiesWithoutRevalidation(request) && (!isCapped || bucket.isFresh(entry));
}

// A GET with `sent` headers answered from `bucket` while fresh, revalidated with its validators once stale, stored when RFC 9111 allows; an entry `isUsable` rejects is fetched again in full, except offline.
export async function fetchCached<T>(bucket: Bucket<Stored<T>>, url: string, consume: (response: Response) => Promise<T>, isCapped = false, isUsable?: (stored: Stored<T>) => boolean, sent: Record<string, string> = {}): Promise<Served<T>> {
    const found = await bucket.get(url);
    const entry = found && (!isUsable || bucket.mode === "offline" || isUsable(found.value)) ? found : undefined;
    if (found && !entry) log.debug({ bucket: bucket.name, url, stored: found.stored }, "cache entry lacks what the caller needs");
    if (!entry) bucket.missed(url);
    const request = REQUEST(url, sent);
    const policy = entry && CachePolicy.fromObject(entry.value.policy);
    if (entry && policy && isFresh(bucket, entry, policy, isCapped, request)) {
        log.debug({ bucket: bucket.name, url, stored: entry.stored }, "served from cache");
        return { ...entry.value, cached: true };
    }
    const conditional = policy ? (policy.revalidationHeaders(request) as Record<string, string>) : {};
    const { response, value, ms } = await fetchRetrying(url, consume, { ...sent, ...conditional });
    const headers = Object.fromEntries(response.headers);
    if (entry && policy && response.status === 304) {
        const { policy: updated, modified } = policy.revalidatedPolicy(request, { status: 304, headers });
        log.debug({ bucket: bucket.name, url, modified }, "revalidated");
        if (!modified) {
            const next = toStored(updated, entry.value.status, { ...entry.value.headers, ...headers }, entry.value.value, ms);
            await bucket.set(url, next);
            return { ...next, revalidated: true };
        }
        const again = await fetchRetrying(url, consume, sent);
        return store(bucket, url, request, again.response, again.value, again.ms);
    }
    return store(bucket, url, request, response, value, ms);
}

// A full response, kept when its policy is storable.
async function store<T>(bucket: Bucket<Stored<T>>, url: string, request: CachePolicy.HttpRequest, response: Response, value: T, ms: number): Promise<Served<T>> {
    const headers = Object.fromEntries(response.headers);
    const policy = new CachePolicy(request, { status: response.status, headers }, OPTIONS);
    const stored = toStored(policy, response.status, headers, value, ms);
    const isStorable = policy.storable();
    log.debug({ bucket: bucket.name, url, status: response.status, isStorable }, "response judged for cache");
    if (isStorable) await bucket.set(url, stored);
    return stored;
}
