// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { trace } from "@opentelemetry/api";
import pino from "pino";
import pretty from "pino-pretty";
import { Writable } from "node:stream";
import { painter, type Style } from "./color.ts";
import { relative, singleOrigin } from "./crawl/scope.ts";
import { progressPrint } from "./progress.ts";
import { isTelemetryConfigured } from "./telemetry-environment.ts";

const level = process.env.SPIDERLINT_LOG_LEVEL ?? "warn";

// The single seed origin trimmed from logged URLs; empty logs them absolute.
const base = { origin: "" };

// Terminal log colors; the CLI's --[no-]color replaces the painter before the first line.
const terminal = { paint: painter(process.stderr) };

const LEVELS: Record<string, Style> = { TRACE: "gray", DEBUG: "gray", INFO: "green", WARN: "yellow", ERROR: "red", FATAL: ["bold", "red"] };
const RESERVED = new Set(["level", "time", "pid", "hostname", "url", "error", "crawlee", "trace_id", "span_id", "trace_flags"]);
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

// True when the message already spells `value` out as a word of its own.
function isSaid(message: string, value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0 && value.every((item) => isSaid(message, item));
    const said = text(value);
    for (let at = message.indexOf(said); said !== "" && at !== -1; at = message.indexOf(said, at + 1)) {
        if (!/\w/.test(message[at - 1] ?? "") && !/\w/.test(message[at + said.length] ?? "")) return true;
    }
    return false;
}

// Message, url and error on one line; other fields only when neither is there and the message does not say them, or at debug.
export function oneLine(entry: Record<string, unknown>, messageKey: string): string {
    const { paint } = terminal;
    const raw = text(entry[messageKey] ?? "");
    const message = raw.replaceAll(URL_IN_TEXT, (url) => paint("cyan", url));
    const isVerbose = log.isLevelEnabled("debug");
    const fields = Object.entries(entry).filter(([key, value]) => key !== messageKey && !RESERVED.has(key) && (isVerbose || !isSaid(raw, value)));
    const hasSubject = entry.url !== undefined || entry.error !== undefined;
    return [
        message,
        entry.url !== undefined && paint("cyan", text(entry.url)),
        entry.error !== undefined && text(entry.error),
        (isVerbose || !hasSubject) && fields.length > 0 && paint("dim", fields.map(([key, value]) => `${key}=${text(value)}`).join(" ")),
    ].filter(Boolean).join(" ");
}

// Stderr under the status line, which each entry prints above.
const stderr = new Writable({
    write(chunk: Buffer, _encoding, done) {
        progressPrint(chunk.toString("utf8"));
        done();
    },
});

// The active span’s IDs, which pino-opentelemetry-transport exports with the record; empty outside a span.
function traceFields(): Record<string, string> {
    const span = trace.getActiveSpan()?.spanContext();
    return span && trace.isSpanContextValid(span) ? { trace_id: span.traceId, span_id: span.spanId, trace_flags: `0${span.traceFlags.toString(16)}`.slice(-2) } : {};
}

// Stderr as a pino destination: JSON for machines, else one readable line per entry.
const destination = process.env.SPIDERLINT_LOG_FORMAT === "json" ? pino.destination(2) : pretty({ destination: stderr, sync: true, colorize: false, ignore: "pid,hostname", hideObject: true, messageFormat: oneLine, customPrettifiers: { level: (_value, _key, _entry, { label }) => terminal.paint(LEVELS[label] ?? "reset", label) } });

// With an OTLP endpoint set, every record also goes to the collector, and stderr stays as it is.
const isExported = isTelemetryConfigured();

// One readable line per entry to stderr, so stdout stays the report; `SPIDERLINT_LOG_FORMAT=json` for machines.
export const log = pino(
    { level, formatters, ...(isExported && { mixin: traceFields }) },
    isExported ? pino.multistream([{ stream: destination, level: "trace" }, { stream: pino.transport({ target: "pino-opentelemetry-transport", options: { resourceAttributes: { "service.name": process.env.OTEL_SERVICE_NAME || "spiderlint" } } }), level: "trace" }]) : destination,
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
    if (next) log.info({ origin: next, seeds: seeds.length }, `paths below are relative to ${next}`);
    else log.debug({ seeds: seeds.length }, "urls logged absolute");
}
