// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { Queue, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Report, Summary } from "../index.ts";
import { log } from "../logger.ts";
import type { Progress } from "../progress.ts";
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

// The key a repeat of this scan finds its job under: the policy, the seed and the settings with keys sorted.
export function repeatKey(admitted: Admitted): string {
    const sorted = JSON.stringify(admitted.settings, (_key, value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b))) : value));
    return `${PREFIX}:repeat:${admitted.policy.name}:${createHash("sha256").update(`${admitted.url}\n${sorted}`).digest("hex")}`;
}

// The key naming the last finished scan of `host`, which the badge reads.
export function latestKey(host: string): string {
    return `${PREFIX}:latest:${host}`;
}
