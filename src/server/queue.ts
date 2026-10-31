// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomBytes } from "node:crypto";
import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Report, Summary } from "../index.ts";
import { log } from "../logger.ts";
import type { Grade } from "../report/rating.ts";
import type { Finding } from "../rules/types.ts";
import { Refusal, type Admitted } from "./policy.ts";

export const QUEUE = "spiderlint-scans";
export const PREFIX = "spiderlint";

// The descriptor a scan runner writes progress to, one JSON line per change.
export const PROGRESS_FD = 3;

export interface ScanData {
    url: string;
    host: string;
    policy: string;
    settings: Record<string, unknown>;
    scanTimeout: number;
    // Rule IDs or globs the policy denies, excluded from every group.
    deny: string[];
    // Instance the scan advertises in its user agent, from the request Host header.
    via: string;
    // The key holding the repeat window, so the job page can say when a fresh scan may start.
    repeatKey?: string;
    // Set when the scan stays out of the latest reports and the badge.
    hidden?: boolean;
    // Set when the scan is one of the instance’s examples, kept until its host’s next one replaces it.
    example?: boolean;
    // The signals the requester grants; unset declares none.
    "content-signals"?: string[];
    // The submitting request’s trace context as W3C headers, empty when telemetry is off.
    trace?: Record<string, string>;
}

// What `--format json` prints: the summary, the findings and the guides of the rules that found something.
export interface ScanResult {
    summary: Summary;
    findings: Finding[];
    rules?: Report["rules"];
}

export type ScanJob = Job<ScanData, ScanResult>;

// One connection per role; BullMQ needs `maxRetriesPerRequest: null` for blocking commands, and retries with backoff itself.
export function connect(url: string, password?: string): Redis {
    // eslint-disable-next-line unicorn/no-null -- BullMQ requires null, not undefined
    const redis = new Redis(url, { ...(password && { password }), maxRetriesPerRequest: null, retryStrategy: (attempt) => Math.min(250 * 2 ** attempt, 10_000) + Math.random() * 250 });
    redis.on("error", (error: Error) => log.warn({ error: error.message }, "redis connection error"));
    return redis;
}

// The scan queue, jobs kept `retention` seconds after they settle and never retried.
export function scanQueue(redis: Redis, retention: number): Queue<ScanData, ScanResult> {
    return new Queue<ScanData, ScanResult>(QUEUE, { connection: redis, prefix: PREFIX, defaultJobOptions: { attempts: 1, removeOnComplete: { age: retention }, removeOnFail: { age: retention } } });
}

// Counts one job against the policy’s window for the host; a full window refuses with the seconds until it opens.
export async function charge(redis: Redis, admitted: Admitted): Promise<void> {
    const { rate } = admitted.policy;
    if (!rate) return;
    const key = `${PREFIX}:rate:${admitted.policy.name}:${admitted.host}`;
    const reply = await redis
        .multi()
        .incr(key)
        .pexpire(key, rate.seconds * 1000, "NX")
        .pttl(key)
        .exec();
    const used = Number(reply?.[0]?.[1] ?? 0);
    const left = Math.ceil(Number(reply?.[2]?.[1] ?? 0) / 1000);
    log.info({ host: admitted.host, policy: admitted.policy.name, used, jobs: rate.jobs, left }, "rate window charged");
    if (used > rate.jobs) throw new Refusal(429, "rate-limited", `${admitted.host}: ${rate.jobs} scans per ${rate.seconds} s under policy ${admitted.policy.name}`, Math.max(1, left));
}

// The key a repeat of this scan finds its job under: the policy, the seed, the settings with keys sorted and whether it is hidden.
export function repeatKey(admitted: Admitted): string {
    const sorted = JSON.stringify(admitted.settings, (_key, value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))) : value));
    return `${PREFIX}:repeat:${admitted.policy.name}:${createHash("sha256")
        .update(`${admitted.url}\n${sorted}${admitted.hidden ? "\nhidden" : ""}${admitted["content-signals"] ? `\n${admitted["content-signals"].join(",")}` : ""}`)
        .digest("hex")}`;
}

// A job ID that names its host and queue time, closed by 48 random bits: `example.org-20261014T171505Z-3f9c1a7e2b4d`.
export function jobId(host: string, at = new Date()): string {
    const stamp = at.toISOString().replaceAll(/[-:]|\.\d+/g, "");
    return `${host.replaceAll(/[^\da-z.-]/g, "-")}-${stamp}-${randomBytes(6).toString("hex")}`;
}

// The key naming the last finished scan of `host`, which the badge reads.
export function latestKey(host: string): string {
    return `${PREFIX}:latest:${host}`;
}

// The key holding a finished scan’s preview: its WebP `image` and the `title` the page showed.
export function previewKey(id: string): string {
    return `${PREFIX}:preview:${id}`;
}

// What the form lists of a host’s latest finished scan.
export interface Recent {
    id: string;
    host: string;
    grade?: Grade;
    finished: number;
    title?: string;
    // Set when the scan has a preview under `previewKey`.
    preview?: true;
    // The edge whose bot wall stopped the scan.
    walled?: string;
}

// The hosts of the latest reports by finish time; each host’s entry sits under its own key.
const RECENT = `${PREFIX}:recent`;

// Points the host’s badge at the finished scan and, while `limit` is above zero, lists it among the latest reports, dropping the oldest past `limit`.
export async function recordLatest(redis: Redis, job: ScanJob, retention: number, limit: number): Promise<void> {
    const entry = await recentOf(redis, job);
    const { host, grade } = entry;
    const pending = redis.multi().set(latestKey(host), entry.id, "EX", retention);
    if (limit > 0)
        pending
            .set(`${RECENT}:${host}`, JSON.stringify(entry), "EX", retention)
            .zadd(RECENT, entry.finished, host)
            .zremrangebyrank(RECENT, 0, -(limit + 1));
    await pending.exec();
    log.debug({ job: entry.id, host, grade, limit }, "latest scan recorded");
}

// What a card shows of the finished `job`.
async function recentOf(redis: Redis, job: ScanJob): Promise<Recent> {
    const { rating, walled } = job.returnvalue.summary;
    const grade = rating?.grade;
    const title = await redis.hget(previewKey(job.id as string), "title");
    return { id: job.id as string, host: job.data.host, finished: job.finishedOn ?? Date.now(), ...(grade && { grade }), ...(title && { title }), ...(title !== null && { preview: true }), ...(walled && { walled }) };
}

// The hash of example entries by host, never expiring.
const EXAMPLES = `${PREFIX}:examples`;

// Makes the finished example its host’s only one; returns the ID of the example it replaced.
export async function recordExample(redis: Redis, job: ScanJob): Promise<string | undefined> {
    const entry = await recentOf(redis, job);
    const [[, previous]] = (await redis.multi().hget(EXAMPLES, entry.host).hset(EXAMPLES, entry.host, JSON.stringify(entry)).exec()) as [[unknown, string | null]];
    const replaced = previous ? (JSON.parse(previous) as Recent).id : undefined;
    log.info({ job: entry.id, host: entry.host, grade: entry.grade, replaced }, "example recorded");
    return replaced === entry.id ? undefined : replaced;
}

// Every example entry by host; a Redis that fails reads as none.
export async function exampleReports(redis: Redis): Promise<Map<string, Recent>> {
    try {
        const raw = await redis.hgetall(EXAMPLES);
        log.debug({ examples: Object.keys(raw).length }, "examples read");
        return new Map(Object.entries(raw).map(([host, entry]) => [host, JSON.parse(entry) as Recent]));
    } catch (error) {
        log.warn({ error: String(error) }, "examples not read");
        return new Map();
    }
}

// Forgets the example of `host`, returning the ID of the scan it named.
export async function dropExample(redis: Redis, host: string): Promise<string | undefined> {
    const [[, previous]] = (await redis.multi().hget(EXAMPLES, host).hdel(EXAMPLES, host).exec()) as [[unknown, string | null]];
    const id = previous ? (JSON.parse(previous) as Recent).id : undefined;
    log.info({ host, job: id }, "example dropped");
    return id;
}

// The latest reports, newest first and at most `limit`; an entry whose scan expired is dropped, and a Redis that fails reads as none.
export async function recentReports(redis: Redis, limit: number): Promise<Recent[]> {
    if (limit <= 0) return [];
    try {
        const hosts = await redis.zrevrange(RECENT, 0, limit - 1);
        const raw = hosts.length > 0 ? await redis.mget(hosts.map((host) => `${RECENT}:${host}`)) : [];
        const gone = hosts.filter((_host, index) => !raw.at(index));
        if (gone.length > 0) await redis.zrem(RECENT, ...gone);
        log.debug({ hosts: hosts.length, gone: gone.length, limit }, "latest reports read");
        return raw.flatMap((entry) => (entry ? [JSON.parse(entry) as Recent] : []));
    } catch (error) {
        log.warn({ limit, error: String(error) }, "latest reports not read");
        return [];
    }
}
