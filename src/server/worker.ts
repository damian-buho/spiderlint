// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "bullmq";
import type { Redis } from "ioredis";
import { log } from "../logger.ts";
import { latestKey, PREFIX, PROGRESS_FD, QUEUE, type ScanData, type ScanJob, type ScanResult } from "./queue.ts";

const RUNNER = new URL("scan.ts", import.meta.url).pathname;
const PROGRESS_MS = 1000;
const REPORT_MAX = 64 * 1024 * 1024;
const TAIL = 20;

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

// One scan in a runner child under a temporary working directory, its progress relayed at most once per second.
async function runScan(job: ScanJob): Promise<ScanResult> {
    const { url, settings, scanTimeout, deny } = job.data;
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
    child.stdin?.end(JSON.stringify({ url, settings, deny }));
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
    clearTimeout(timer);
    if (progress.held) store(progress.held);
    running.delete(child);
    await rm(cwd, { recursive: true, force: true });
    log.info({ job: job.id, url, code, signal, bytes: size }, "scan exited");
    if (code !== 0) throw new Error(reasonOf(code, tail, isTimedOut, scanTimeout));
    if (size > REPORT_MAX) throw new Error(`the report exceeds ${REPORT_MAX} bytes`);
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ScanResult;
}

// Takes `concurrency` scans at a time off the queue until `close`, which kills the runners in flight; a finished scan becomes its host’s latest for `retention` seconds.
export function startWorker(redis: Redis, concurrency: number, retention: number): { close(): Promise<void> } {
    const worker = new Worker<ScanData, ScanResult>(QUEUE, runScan, { connection: redis, prefix: PREFIX, concurrency });
    worker.on("failed", (job, error) => log.warn({ job: job?.id, host: job?.data.host, error: error.message }, "scan failed"));
    worker.on("completed", async (job) => {
        log.info({ job: job.id, host: job.data.host, findings: job.returnvalue.findings.length, grade: job.returnvalue.summary.rating?.grade }, "scan completed");
        try {
            await redis.set(latestKey(job.data.host), job.id as string, "EX", retention);
        } catch (error) {
            log.warn({ job: job.id, error: String(error) }, "latest scan not recorded");
        }
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
