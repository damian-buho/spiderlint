// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import type { Redis } from "ioredis";
import { plain } from "../color.ts";
import type { Report } from "../index.ts";
import { log } from "../logger.ts";
import { formatNames, formatter } from "../plugins/index.ts";
import { admit, Refusal } from "./policy.ts";
import { charge, type ScanData, type ScanJob, type ScanResult } from "./queue.ts";
import type { ServerSettings } from "./settings.ts";

const BODY_MAX = 64 * 1024;
const EVENTS_MS = 1000;

// BullMQ states as the API names them; anything else is still waiting its turn.
const STATUS: Record<string, string> = { active: "running", completed: "done", failed: "failed" };

// Media type and file extension per bundled format; a plugin’s format is plain text.
const MEDIA: Record<string, [string, string]> = { json: ["application/json", "json"], sarif: ["application/sarif+json", "sarif"], csv: ["text/csv", "csv"], checkstyle: ["application/xml", "xml"], human: ["text/plain", "txt"] };

function iso(ms: number | undefined): string | undefined {
    return ms ? new Date(ms).toISOString() : undefined;
}

// A job as clients see it, with relative links so no Host header is trusted.
async function view(job: ScanJob): Promise<Record<string, unknown>> {
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
        links: { self, events: `${self}/events`, ...(status === "done" && { reports: Object.fromEntries(formatNames().map((name) => [name, `${self}/report/${name}`])) }) },
    };
}

// The job the path names, or a 404.
async function jobOf(queue: Queue<ScanData, ScanResult>, id: string): Promise<ScanJob> {
    const job = (await queue.getJob(id)) as ScanJob | undefined;
    if (!job) throw new Refusal(404, "not-found", `job ${id}: not found or expired`);
    return job;
}

// The refusal as `{ error: { code, message } }`, with Retry-After when it has one.
function refused(c: Context, refusal: Refusal): Response {
    if (refusal.retryAfter !== undefined) c.header("retry-after", String(refusal.retryAfter));
    return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
}

// The routes over one queue; `settings` is read per request, so a reloaded policy applies at once.
export function api(queue: Queue<ScanData, ScanResult>, redis: Redis, settings: () => ServerSettings): Hono {
    const app = new Hono();
    app.use(secureHeaders());
    app.use(async (c, next) => {
        const started = performance.now();
        await next();
        log.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started) }, "request served");
    });
    app.onError((error, c) => {
        if (error instanceof Refusal) return refused(c, error);
        log.error({ path: c.req.path, error: error.message }, "request failed");
        return c.json({ error: { code: "internal", message: "internal error" } }, 500);
    });
    app.notFound((c) => refused(c, new Refusal(404, "not-found", `${c.req.path}: no such route`)));

    app.post("/v1/jobs", bodyLimit({ maxSize: BODY_MAX, onError: (c) => refused(c, new Refusal(400, "invalid-body", `the body exceeds ${BODY_MAX} bytes`)) }), async (c) => {
        let body: unknown;
        try {
            body = await c.req.json();
        } catch {
            throw new Refusal(400, "invalid-body", "the body is not JSON");
        }
        const current = settings();
        const admitted = admit(body, current);
        const waiting = await queue.getWaitingCount();
        log.debug({ waiting, maxQueued: current.maxQueued }, "queue depth checked");
        if (waiting >= current.maxQueued) throw new Refusal(503, "queue-full", `${waiting} scans are waiting; try again later`, 60);
        await charge(redis, admitted);
        const data: ScanData = { url: admitted.url, host: admitted.host, policy: admitted.policy.name, settings: admitted.settings, scanTimeout: admitted.policy.scanTimeout, deny: admitted.policy.rules.deny };
        const job = (await queue.add("scan", data, { jobId: randomUUID() })) as ScanJob;
        log.info({ job: job.id, host: admitted.host, policy: admitted.policy.name }, "scan queued");
        c.header("location", `/v1/jobs/${job.id}`);
        return c.json(await view(job), 202);
    });

    app.get("/v1/jobs/:id", async (c) => {
        const job = await jobOf(queue, c.req.param("id"));
        return c.json(await view(job));
    });

    app.get("/v1/jobs/:id/events", async (c) => {
        const id = c.req.param("id");
        await jobOf(queue, id);
        return streamSSE(c, async (stream) => {
            let last = "";
            while (!stream.aborted) {
                const job = (await queue.getJob(id)) as ScanJob | undefined;
                const current = job ? await view(job) : undefined;
                const data = JSON.stringify(current ?? { id, status: "expired" });
                const event = current ? (["done", "failed"].includes(current.status as string) ? (current.status as string) : "progress") : "expired";
                if (data !== last) await stream.writeSSE({ event, data });
                log.debug({ job: id, event, isChanged: data !== last }, "job event polled");
                last = data;
                if (event !== "progress") break;
                await stream.sleep(EVENTS_MS);
            }
        });
    });

    app.get("/v1/jobs/:id/report/:format", async (c) => {
        const job = await jobOf(queue, c.req.param("id"));
        const name = c.req.param("format");
        const format = formatter(name);
        if (!format) throw new Refusal(404, "unknown-format", `${name}: not one of ${formatNames().join(", ")}`);
        if ((await job.getState()) !== "completed") throw new Refusal(409, "not-ready", `job ${job.id}: no report until it is done`);
        const [media, extension] = MEDIA[name] ?? ["text/plain", "txt"];
        const report = { pages: [], site: {}, ...job.returnvalue } as unknown as Report;
        c.header("content-type", `${media}; charset=utf-8`);
        c.header("content-disposition", `inline; filename="spiderlint-${job.data.host.replaceAll(/[^\w.-]/g, "-")}.${extension}"`);
        return c.body(format(report, plain, false));
    });

    app.get("/healthz", async (c) => {
        const [pong, counts] = await Promise.all([redis.ping(), queue.getJobCounts("waiting", "active", "delayed", "completed", "failed")]);
        return c.json({ status: pong === "PONG" ? "ok" : "degraded", queue: counts });
    });

    return app;
}
