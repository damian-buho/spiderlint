#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { serve } from "@hono/node-server";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { api } from "./api.ts";
import { connect, scanQueue } from "./queue.ts";
import { DEFAULT_PATH, watchSettings } from "./settings.ts";
import { startWorker } from "./worker.ts";

const MODES = ["api", "worker", "all"];

// Starts the API, the worker or both, per SPIDERLINT_MODE, until SIGTERM or SIGINT.
function main(): void {
    const mode = process.env.SPIDERLINT_MODE ?? "all";
    if (!MODES.includes(mode)) throw new ConfigError(`SPIDERLINT_MODE: invalid value ${mode} (expected: ${MODES.join("|")})`);
    const path = process.env.SPIDERLINT_SERVER_CONFIG ?? DEFAULT_PATH;
    const settings = watchSettings(path);
    const { redis: url, listen, retention, workers } = settings.current();
    log.info({ mode, path, listen, workers }, "server starting");
    const closers: (() => Promise<unknown>)[] = [];
    if (mode !== "worker") {
        const redis = connect(url);
        const queue = scanQueue(redis, retention);
        const server = serve({ fetch: api(queue, redis, settings.current).fetch, hostname: listen.host, port: listen.port }, (info) => log.info({ address: info.address, port: info.port }, "api listening"));
        closers.push(async () => new Promise((resolve) => server.close(resolve)), async () => queue.close(), async () => redis.quit());
    }
    if (mode !== "api") {
        const redis = connect(url);
        const worker = startWorker(redis, workers);
        closers.push(async () => worker.close(), async () => redis.quit());
    }
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
    main();
} catch (error) {
    log.fatal({ error: error instanceof Error ? error.message : String(error) }, "server not started");
    process.exitCode = error instanceof ConfigError ? 2 : 4;
}
