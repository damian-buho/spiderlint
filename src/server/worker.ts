// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Job, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { log } from "../logger.ts";
import { inSpan, recordScan, traceCarrier, withTraceCarrier } from "../telemetry.ts";
import { PREVIEW_FILE } from "./preview.ts";
import { PREFIX, previewKey, PROGRESS_FD, QUEUE, recordExample, recordLatest, type ScanData, type ScanJob, type ScanResult } from "./queue.ts";
import type { ServerSettings } from "./settings.ts";

const RUNNER = new URL(`scan${path.extname(import.meta.url)}`, import.meta.url).pathname;
const PROGRESS_MS = 1000;
const REPORT_MAX = 64 * 1024 * 1024;
const TAIL = 20;
// The share of a scan’s time the crawl may use, leaving the rest to lint and the report.
const CRAWL_SHARE = 0.6;
// The share after which every network phase stops, leaving the rest to the rules, the report and the preview.
const ANALYSIS_SHARE = 0.9;
// Seconds before the scan’s timeout by which a preview must be done.
const PREVIEW_MARGIN_S = 5;

// Why a runner exit code failed the scan, as the job’s error says it.
const EXITS: Record<number, string> = { 2: "invalid settings", 3: "no page could be fetched", 4: "the scan failed" };

// Runners in flight, killed together on shutdown.
const running = new Set<ChildProcess>();

// Pipes each line of `stream` to `onLine`.
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
    createInterface({ input: stream, crlfDelay: Infinity }).on("line", onLine);
}

// One JSON log line of a runner, or nothing when it is not JSON.
function parsed(line: string): { level?: number; error?: string } {
    try {
        return JSON.parse(line) as { level?: number; error?: string };
    } catch {
        return {};
    }
}

// The last error a runner logged, else the meaning of its exit code.
function reasonOf(code: number | null, tail: string[], isTimedOut: boolean, scanTimeout: number): string {
    if (isTimedOut) return `the scan exceeded ${scanTimeout} s`;
    const logged = tail.map((line) => parsed(line)).findLast((entry) => (entry.level ?? 0) >= 50);
    return [EXITS[code ?? 4] ?? `the scan exited with ${code}`, logged?.error].filter(Boolean).join(": ");
}

// One scan as a span continuing the submitting request’s trace, timed by outcome.
async function tracedScan(job: ScanJob, redis: Redis, settings: ServerSettings): Promise<ScanResult> {
    const started = performance.now();
    try {
        const result = await withTraceCarrier(job.data.trace, async () => inSpan("scan job", { "spiderlint.job": String(job.id), "url.full": job.data.url, "spiderlint.policy": job.data.policy }, async () => runScan(job, redis, settings)));
        recordScan((performance.now() - started) / 1000, "done", result.summary.pages);
        return result;
    } catch (error) {
        recordScan((performance.now() - started) / 1000, "failed");
        throw error;
    }
}

// Stores the preview the runner left in `cwd`, for `retention` seconds unless the scan is an example; a missing or broken one is skipped.
async function storePreview(redis: Redis, job: ScanJob, cwd: string, retention: number): Promise<void> {
    try {
        const { title, image } = JSON.parse(await readFile(path.join(cwd, PREVIEW_FILE), "utf8")) as { title: string; image: string };
        const key = previewKey(job.id as string);
        const pending = redis.multi().hset(key, { title, image: Buffer.from(image, "base64") });
        if (!job.data.example) pending.expire(key, retention);
        await pending.exec();
        log.debug({ job: job.id, title, isExample: job.data.example === true }, "preview stored");
    } catch (error) {
        log.debug({ job: job.id, error: String(error) }, "no preview stored");
    }
}

// One scan in a runner child under a temporary working directory, its progress relayed at most once per second.
async function runScan(job: ScanJob, redis: Redis, server: ServerSettings): Promise<ScanResult> {
    const { url, settings, scanTimeout, deny, via, "content-signals": signals } = job.data;
    const previewBy = server.previews && !job.data.hidden ? Date.now() + (scanTimeout - PREVIEW_MARGIN_S) * 1000 : undefined;
    const cwd = await mkdtemp(path.join(tmpdir(), "spiderlint-scan-"));
    const child = spawn(process.execPath, ["--experimental-strip-types", RUNNER], { cwd, stdio: ["pipe", "pipe", "pipe", "pipe"], env: { ...process.env, SPIDERLINT_LOG_FORMAT: "json" } });
    running.add(child);
    log.info({ job: job.id, url, pid: child.pid, scanTimeout }, "scan started");
    let isTimedOut = false;
    const timer = setTimeout(() => {
        isTimedOut = true;
        child.kill("SIGKILL");
    }, scanTimeout * 1000);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= REPORT_MAX) chunks.push(chunk);
    });
    const tail: string[] = [];
    lines(child.stderr as NodeJS.ReadableStream, (line) => {
        tail.push(line);
        if (tail.length > TAIL) tail.shift();
        log.debug({ job: job.id, line }, "runner log");
    });
    const progress = { sent: 0, held: "" };
    const store = (line: string) => void job.updateProgress(JSON.parse(line) as object).catch((error: unknown) => log.warn({ job: job.id, error: String(error) }, "progress not stored"));
    lines(child.stdio[PROGRESS_FD] as NodeJS.ReadableStream, (line) => {
        const now = Date.now();
        // A line inside the interval is held, so the last one is stored once the runner exits.
        progress.held = now - progress.sent < PROGRESS_MS ? line : "";
        if (progress.held) return;
        progress.sent = now;
        store(line);
    });
    child.stdin?.end(JSON.stringify({ url, settings, deny, via, "content-signals": signals, crawlDeadline: Math.floor(scanTimeout * CRAWL_SHARE), analysisDeadline: Math.floor(scanTimeout * ANALYSIS_SHARE), previewBy, trace: traceCarrier() }));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
    clearTimeout(timer);
    if (progress.held) store(progress.held);
    running.delete(child);
    if (code === 0 && previewBy) await storePreview(redis, job, cwd, server.retention);
    await rm(cwd, { recursive: true, force: true });
    log.info({ job: job.id, url, code, signal, bytes: size }, "scan exited");
    if (code !== 0) throw new Error(reasonOf(code, tail, isTimedOut, scanTimeout));
    if (size > REPORT_MAX) throw new Error(`the report exceeds ${REPORT_MAX} bytes`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ScanResult;
}

// Records the finished example and removes the scan and preview it replaces.
async function replaceExample(redis: Redis, worker: Worker<ScanData, ScanResult>, job: ScanJob): Promise<void> {
    try {
        const replaced = await recordExample(redis, job);
        if (!replaced) return;
        const old = await Job.fromId(worker, replaced);
        await old?.remove();
        await redis.del(previewKey(replaced));
        log.info({ job: job.id, replaced }, "previous example removed");
    } catch (error) {
        log.warn({ job: job.id, error: String(error) }, "example not recorded");
    }
}

// Takes `concurrency` scans at a time off the queue until `close`, which kills the runners in flight; a finished scan, unless hidden, becomes its host’s latest for `retention` seconds and one of the latest reports the settings keep, and an example replaces its host’s previous one.
export function startWorker(redis: Redis, concurrency: number, retention: number, settings: () => ServerSettings): { close(): Promise<void> } {
    const worker = new Worker<ScanData, ScanResult>(QUEUE, async (job) => tracedScan(job, redis, settings()), { connection: redis, prefix: PREFIX, concurrency });
    worker.on("failed", (job, error) => log.warn({ job: job?.id, host: job?.data.host, error: error.message }, "scan failed"));
    worker.on("completed", async (job) => {
        log.info({ job: job.id, host: job.data.host, findings: job.returnvalue.findings.length, grade: job.returnvalue.summary.rating?.grade }, "scan completed");
        if (job.data.hidden) {
            log.info({ job: job.id, host: job.data.host }, "hidden scan left out of the latest");
            return;
        }
        try {
            await recordLatest(redis, job, retention, settings().recent);
        } catch (error) {
            log.warn({ job: job.id, error: String(error) }, "latest scan not recorded");
        }
        if (job.data.example) await replaceExample(redis, worker, job);
    });
    log.info({ queue: QUEUE, concurrency }, "worker started");
    return {
        async close() {
            log.info({ running: running.size }, "worker stopping");
            for (const child of running) child.kill("SIGKILL");
            await worker.close(true);
        },
    };
}
