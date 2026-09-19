// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log as crawleeLog, Logger, LogLevel } from "crawlee";
import { log } from "../logger.ts";

type Method = "error" | "warn" | "info" | "debug" | "trace";

const METHOD: Partial<Record<LogLevel, Method>> = {
    [LogLevel.ERROR]: "error",
    [LogLevel.SOFT_FAIL]: "warn",
    [LogLevel.WARNING]: "warn",
    [LogLevel.INFO]: "info",
    [LogLevel.DEBUG]: "debug",
    [LogLevel.PERF]: "trace",
};

// Crawlee lines land in the pino stream with their data fields and a `crawlee` marker.
class PinoLogger extends Logger {
    override _log(level: LogLevel, message: string, data?: Record<string, unknown>, exception?: unknown, options?: Record<string, unknown>): void {
        const error = exception instanceof Error ? exception.message : exception;
        log[METHOD[level] ?? "info"]({ ...data, crawlee: options?.prefix ?? true, ...(error !== undefined && { error }) }, message.split("\n    at ", 1)[0] as string);
    }
}

// Crawlee stays at WARNING unless spiderlint itself is at debug or below.
export function bridgeCrawleeLog(): void {
    const isVerbose = log.levelVal <= log.levels.values.debug!;
    crawleeLog.setOptions({ logger: new PinoLogger({}), level: isVerbose ? LogLevel.DEBUG : LogLevel.WARNING });
}
