// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import pino from "pino";
import { relative, singleOrigin } from "./crawl/scope.ts";

const level = process.env.SPIDERLINT_LOG_LEVEL ?? "info";

// The single seed origin trimmed from logged URLs; empty logs them absolute.
const base = { origin: "" };

// Strings, and strings inside arrays, lose the base origin.
function shorten(value: unknown): unknown {
    if (typeof value === "string") return relative(value, base.origin);
    return Array.isArray(value) ? value.map((item) => shorten(item)) : value;
}

// Every top-level field of a line, Crawlee’s bridged lines included.
const formatters = { log: (object: Record<string, unknown>) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, shorten(value)])) };

// JSON to stderr so stdout stays the report; pretty only on a terminal.
export const log = pino(
    process.stderr.isTTY
        ? { level, formatters, transport: { target: "pino-pretty", options: { destination: 2, ignore: "pid,hostname" } } }
        : { level, formatters },
    process.stderr.isTTY ? undefined : pino.destination(2),
);

// Seeds sharing one origin make it the base of every logged URL; mixed origins keep URLs absolute.
export function logRelativeTo(seeds: string[]): void {
    const next = singleOrigin(seeds);
    if (next === base.origin) return;
    base.origin = next;
    log.info({ origin: next, seeds: seeds.length }, next ? "urls logged relative to origin" : "urls logged absolute");
}
