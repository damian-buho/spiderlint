// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import pino from "pino";
import pretty from "pino-pretty";
import { painter, type Style } from "./color.ts";
import { relative, singleOrigin } from "./crawl/scope.ts";

const level = process.env.SPIDERLINT_LOG_LEVEL ?? "info";

// The single seed origin trimmed from logged URLs; empty logs them absolute.
const base = { origin: "" };

// Terminal log colors; the CLI's --[no-]color replaces the painter before the first line.
const terminal = { paint: painter(process.stderr) };

const LEVELS: Record<string, Style> = { TRACE: "gray", DEBUG: "gray", INFO: "green", WARN: "yellow", ERROR: "red", FATAL: ["bold", "red"] };
const RESERVED = new Set(["level", "time", "pid", "hostname", "url", "error", "crawlee"]);
const URL_IN_TEXT = /https?:\/\/\S+/g;

// Strings, and strings inside arrays, lose the base origin.
function shorten(value: unknown): unknown {
    if (typeof value === "string") return relative(value, base.origin);
    return Array.isArray(value) ? value.map((item) => shorten(item)) : value;
}

// Every top-level field of a line, Crawlee’s bridged lines included.
const formatters = { log: (object: Record<string, unknown>) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, shorten(value)])) };

function text(value: unknown): string {
    if (typeof value === "string") return value;
    return value instanceof Error ? value.message : JSON.stringify(value);
}

// Message, url and error on one line; other fields only when neither is there, or at debug.
export function oneLine(entry: Record<string, unknown>, messageKey: string): string {
    const { paint } = terminal;
    const message = text(entry[messageKey] ?? "").replaceAll(URL_IN_TEXT, (url) => paint("cyan", url));
    const fields = Object.entries(entry).filter(([key]) => key !== messageKey && !RESERVED.has(key));
    const hasSubject = entry.url !== undefined || entry.error !== undefined;
    const isVerbose = log.isLevelEnabled("debug");
    return [
        message,
        entry.url !== undefined && paint("cyan", text(entry.url)),
        entry.error !== undefined && text(entry.error),
        (isVerbose || !hasSubject) && fields.length > 0 && paint("dim", fields.map(([key, value]) => `${key}=${text(value)}`).join(" ")),
    ].filter(Boolean).join(" ");
}

// `pretty` or `json`; unset, a terminal gets `pretty`.
const format = process.env.SPIDERLINT_LOG_FORMAT ?? (process.stderr.isTTY ? "pretty" : "json");

// JSON to stderr so stdout stays the report; one readable line per entry when pretty.
export const log = pino(
    { level, formatters },
    format === "pretty"
        ? pretty({ destination: 2, sync: true, colorize: false, ignore: "pid,hostname", hideObject: true, messageFormat: oneLine, customPrettifiers: { level: (_value, _key, _entry, { label }) => terminal.paint(LEVELS[label] ?? "reset", label) } })
        : pino.destination(2),
);

// Whether pino knows `name`, as --log-level must name one.
export function isLogLevel(name: string): boolean {
    return name === "silent" || log.levels.values[name] !== undefined;
}

// Forces or disables terminal log colors, as --[no-]color does for the report.
export function logColor(hasColor: boolean | undefined): void {
    terminal.paint = painter(process.stderr, hasColor);
}

// Seeds sharing one origin make it the base of every logged URL; mixed origins keep URLs absolute.
export function logRelativeTo(seeds: string[]): void {
    const next = singleOrigin(seeds);
    if (next === base.origin) return;
    base.origin = next;
    log.info({ origin: next, seeds: seeds.length }, next ? "urls logged relative to origin" : "urls logged absolute");
}
