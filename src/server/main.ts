#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { api } from "./api.ts";
import { connect, scanQueue } from "./queue.ts";
import { DEFAULT_PATH, watchSettings } from "./settings.ts";
import { startWorker } from "./worker.ts";
import { observeQueue, startTelemetry } from "../telemetry.ts";

const MODES = ["api", "worker", "all"];

// Starts the API, the worker or both, per SPIDERLINT_MODE, until SIGTERM or SIGINT.
async function main(): Promise<void> {
    const mode = process.env.SPIDERLINT_MODE ?? "all";
    if (!MODES.includes(mode)) throw new ConfigError(`SPIDERLINT_MODE: invalid value ${mode} (expected: ${MODES.join("|")})`);
    const path = process.env.SPIDERLINT_SERVER_CONFIG ?? DEFAULT_PATH;
    const settings = watchSettings(path);
    const { redis: url, redisPasswordFile, listen, retention, workers } = settings.current();
    const password = redisPasswordFile ? readFileSync(redisPasswordFile, "utf8").trim() : undefined;
    log.info({ mode, path, listen, workers, redisPasswordFile }, "server starting");
    const telemetry = await startTelemetry("spiderlint");
    const closers: (() => Promise<unknown>)[] = [];
    if (mode !== "worker") {
        const redis = connect(url, password);
        const queue = scanQueue(redis, retention);
        observeQueue(async () => queue.getJobCounts("waiting", "active", "delayed", "prioritized"));
        const server = serve({ fetch: api(queue, redis, settings.current).fetch, hostname: listen.host, port: listen.port }, (info) => log.info({ address: info.address, port: info.port }, "api listening"));
        closers.push(async () => new Promise((resolve) => server.close(resolve)), async () => queue.close(), async () => redis.quit());
    }
    if (mode !== "api") {
        const redis = connect(url, password);
        const worker = startWorker(redis, workers, retention);
        closers.push(async () => worker.close(), async () => redis.quit());
    }
    if (telemetry) closers.push(async () => telemetry.shutdown());
    const stop = async (signal: string) => {
        log.info({ signal, closers: closers.length }, "server stopping");
        settings.close();
        for (const close of closers) {
            try {
                await close();
            } catch (error) {
                log.warn({ error: String(error) }, "close failed");
            }
        }
        log.info({ signal }, "server stopped");
    };
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, (name) => void stop(name));
}

try {
    await main();
} catch (error) {
    log.fatal({ error: error instanceof Error ? error.message : String(error) }, "server not started");
    process.exitCode = error instanceof ConfigError ? 2 : 4;
}
