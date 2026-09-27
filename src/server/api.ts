// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Queue } from "bullmq";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import type { Redis } from "ioredis";
import { plain } from "../color.ts";
import { negotiate } from "../i18n.ts";
import type { Report } from "../index.ts";
import { log } from "../logger.ts";
import { formatNames, formatter } from "../plugins/index.ts";
import { Buckets } from "./clients.ts";
import { jobOf, submit, view, type Jobs } from "./jobs.ts";
import { Refusal } from "./policy.ts";
import type { ScanData, ScanJob, ScanResult } from "./queue.ts";
import type { ServerSettings } from "./settings.ts";
import { PAGE_CSP, web } from "./web.ts";

export const BODY_MAX = 64 * 1024;
const EVENTS_MS = 1000;

// Media type and file extension per bundled format; a plugin’s format is plain text.
const MEDIA: Record<string, [string, string]> = { json: ["application/json", "json"], sarif: ["application/sarif+json", "sarif"], csv: ["text/csv", "csv"], checkstyle: ["application/xml", "xml"], human: ["text/plain", "txt"], html: ["text/html", "html"] };

// The refusal as `{ error: { code, message } }`, with Retry-After when it has one.
export function refused(c: Context, refusal: Refusal): Response {
    if (refusal.retryAfter !== undefined) c.header("retry-after", String(refusal.retryAfter));
    return c.json({ error: { code: refusal.code, message: refusal.message } }, refusal.status);
}

// The routes over one queue; `settings` is read per request, so a reloaded policy applies at once.
export function api(queue: Queue<ScanData, ScanResult>, redis: Redis, settings: () => ServerSettings): Hono {
    const jobs: Jobs = { queue, redis, settings, buckets: new Buckets() };
    const app = new Hono();
    // Registered first so it runs last: a badge may be embedded by any site.
    app.use("/badge/*", async (c, next) => {
        await next();
        c.header("cross-origin-resource-policy", "cross-origin");
    });
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
        const { job, isRepeat } = await submit(jobs, body, c);
        c.header("location", `/v1/jobs/${job.id}`);
        return c.json(await view(job), isRepeat ? 200 : 202);
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
        c.header("content-security-policy", PAGE_CSP);
        c.header("content-disposition", `inline; filename="spiderlint-${job.data.host.replaceAll(/[^\w.-]/g, "-")}.${extension}"`);
        const lang = negotiate(c.req.header("accept-language"));
        return c.body(format(report, plain, false, lang));
    });

    app.get("/healthz", async (c) => {
        const [pong, counts] = await Promise.all([redis.ping(), queue.getJobCounts("waiting", "active", "delayed", "completed", "failed")]);
        return c.json({ status: pong === "PONG" ? "ok" : "degraded", queue: counts });
    });

    app.route("/", web(jobs));
    return app;
}
