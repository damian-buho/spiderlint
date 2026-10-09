// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { BlockList } from "node:net";
import type { Queue } from "bullmq";
import type { Context } from "hono";
import type { Redis } from "ioredis";
import { log } from "../logger.ts";
import { formatNames } from "../plugins/index.ts";
import { Buckets, clientOf } from "./clients.ts";
import { admit, Refusal, resolveRules } from "./policy.ts";
import { charge, repeatKey, type ScanData, type ScanJob, type ScanResult } from "./queue.ts";
import type { ServerSettings } from "./settings.ts";
import { traceCarrier } from "../telemetry.ts";

// BullMQ states as the API names them; anything else is still waiting its turn.
const STATUS: Record<string, string> = { active: "running", completed: "done", failed: "failed" };

// What every route shares: the queue, its Redis connection, the live settings, the client buckets and the CDN edges trusted like proxies.
export interface Jobs {
    queue: Queue<ScanData, ScanResult>;
    redis: Redis;
    settings: () => ServerSettings;
    buckets: Buckets;
    edges: { list: BlockList };
}

function iso(ms: number | undefined): string | undefined {
    return ms ? new Date(ms).toISOString() : undefined;
}

// A job as clients see it, with relative links so no Host header is trusted.
export async function view(job: ScanJob): Promise<Record<string, unknown> & { status: string }> {
    const status = STATUS[await job.getState()] ?? "queued";
    const self = `/v1/jobs/${job.id}`;
    return {
        id: job.id,
        url: job.data.url,
        policy: job.data.policy,
        status,
        ...(typeof job.progress === "object" && { progress: job.progress }),
        created: iso(job.timestamp),
        started: iso(job.processedOn),
        finished: iso(job.finishedOn),
        ...(status === "failed" && { error: job.failedReason }),
        ...(status === "done" && { summary: job.returnvalue.summary }),
        links: { self, page: `/jobs/${job.id}`, events: `${self}/events`, ...(status === "done" && { reports: Object.fromEntries(formatNames().map((name) => [name, `${self}/report/${name}`])) }) },
    };
}

// The job the path names, or a 404.
export async function jobOf(queue: Queue<ScanData, ScanResult>, id: string): Promise<ScanJob> {
    const job = (await queue.getJob(id)) as ScanJob | undefined;
    if (!job) throw new Refusal(404, "not-found", `job ${id}: not found or expired`);
    return job;
}

// The job a repeat of this scan returns: queued, running or done inside the policy’s window.
async function repeated(jobs: Jobs, key: string): Promise<ScanJob | undefined> {
    const id = await jobs.redis.get(key);
    const job = id ? ((await jobs.queue.getJob(id)) as ScanJob | undefined) : undefined;
    const state = await job?.getState();
    log.debug({ job: id, state }, "repeat looked up");
    return state && state !== "failed" ? job : undefined;
}

// The address a request came from, through the proxies and CDN edges the settings trust.
export function clientAddress(c: Context, jobs: Jobs): string {
    const peer = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress ?? "";
    return clientOf(peer, c.req.header("x-forwarded-for"), [jobs.settings().clients.trusted, jobs.edges.list]);
}

// Admits `body` and queues its scan, or returns the job it repeats; every refusal comes before the host’s window is charged.
export async function submit(jobs: Jobs, body: unknown, c: Context): Promise<{ job: ScanJob; isRepeat: boolean }> {
    const current = jobs.settings();
    const admitted = admit(body, current);
    await resolveRules(admitted);
    const key = repeatKey(admitted);
    const repeat = admitted.policy.repeat ? await repeated(jobs, key) : undefined;
    if (repeat) {
        log.info({ job: repeat.id, host: admitted.host, policy: admitted.policy.name }, "scan repeated");
        return { job: repeat, isRepeat: true };
    }
    const waiting = await jobs.queue.getWaitingCount();
    log.debug({ waiting, maxQueued: current.maxQueued }, "queue depth checked");
    if (waiting >= current.maxQueued) throw new Refusal(503, "queue-full", `${waiting} scans are waiting; try again later`, 60);
    const { rate } = current.clients;
    const wait = rate ? jobs.buckets.take(clientAddress(c, jobs), rate) : 0;
    if (rate && wait > 0) throw new Refusal(429, "client-rate-limited", `a client may queue ${rate.jobs} scans per ${rate.seconds} s`, wait);
    await charge(jobs.redis, admitted);
    const data: ScanData = { url: admitted.url, host: admitted.host, policy: admitted.policy.name, settings: admitted.settings, scanTimeout: admitted.policy.scanTimeout, deny: admitted.policy.rules.deny, ...(admitted.policy.repeat && { repeatKey: key }), trace: traceCarrier() };
    const job = (await jobs.queue.add("scan", data, { jobId: randomUUID() })) as ScanJob;
    if (admitted.policy.repeat) await jobs.redis.set(key, job.id as string, "EX", admitted.policy.repeat);
    log.info({ job: job.id, host: admitted.host, policy: admitted.policy.name, repeat: admitted.policy.repeat }, "scan queued");
    return { job, isRepeat: false };
}
