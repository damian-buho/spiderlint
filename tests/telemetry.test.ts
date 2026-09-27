// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { isTelemetryConfigured } from "../src/telemetry-environment.ts";
import { startTelemetry, traceCarrier } from "../src/telemetry.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const RUNNER = new URL("../src/server/scan.ts", import.meta.url).pathname;
// The environment without any OTEL_ variable the developer’s shell may carry.
const BARE = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("OTEL_")));

interface Span {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
}

// What an OTLP/JSON collector received: spans, log records’ trace IDs and metric names.
interface Received {
    spans: Span[];
    logTraces: string[];
    metrics: string[];
}

type Json = Record<string, unknown>;
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

// What each OTLP/JSON path adds to the received signals.
const SIGNALS: Record<string, (body: Json, received: Received) => void> = {
    "/v1/traces": (body, received) => {
        for (const resource of list(body.resourceSpans)) for (const scope of list(resource.scopeSpans)) received.spans.push(...(list(scope.spans) as unknown as Span[]));
    },
    "/v1/logs": (body, received) => {
        for (const resource of list(body.resourceLogs)) for (const scope of list(resource.scopeLogs)) received.logTraces.push(...list(scope.logRecords).flatMap((record) => (typeof record.traceId === "string" && record.traceId ? [record.traceId] : [])));
    },
    "/v1/metrics": (body, received) => {
        for (const resource of list(body.resourceMetrics)) for (const scope of list(resource.scopeMetrics)) received.metrics.push(...list(scope.metrics).map((metric) => String(metric.name)));
    },
};

// A collector taking OTLP/JSON on /v1/traces, /v1/logs and /v1/metrics.
async function collector(): Promise<{ server: Server; endpoint: string; received: Received }> {
    const received: Received = { spans: [], logTraces: [], metrics: [] };
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
        });
        request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json;
            SIGNALS[request.url ?? ""]?.(body, received);
            response.writeHead(200, { "content-type": "application/json" }).end("{}");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
}

describe("telemetry off", () => {
    it("needs an OTLP endpoint and honours OTEL_SDK_DISABLED", () => {
        assert.equal(isTelemetryConfigured({}), false);
        assert.equal(isTelemetryConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }), true);
        assert.equal(isTelemetryConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_SDK_DISABLED: "true" }), false);
    });

    it("creates no exporter and registers no provider without the variables", async () => {
        for (const name of Object.keys(process.env)) if (name.startsWith("OTEL_")) delete process.env[name];
        assert.equal(await startTelemetry("spiderlint"), undefined);
        const registry = (globalThis as Record<symbol, Record<string, unknown> | undefined>)[Symbol.for("opentelemetry.js.api.1")];
        assert.equal(registry?.trace, undefined);
        assert.equal(registry?.metrics, undefined);
        assert.deepEqual(traceCarrier(), {});
    });
});

describe("telemetry on", () => {
    let site: Fixture;
    let otlp: Awaited<ReturnType<typeof collector>>;
    let directory: string;

    before(async () => {
        const scratch = path.join(tmpdir(), "spiderlint-otel-");
        [site, otlp, directory] = await Promise.all([serveFixture(), collector(), mkdtemp(scratch)]);
    });
    after(async () => {
        await Promise.all([site.close(), new Promise((resolve) => otlp.server.close(resolve)), rm(directory, { recursive: true, force: true })]);
    });

    const environment = () => ({ ...BARE, OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_SERVICE_NAME: "spiderlint-test", SPIDERLINT_LOG_FORMAT: "json", XDG_CACHE_HOME: path.join(directory, "cache") });

    it("traces a CLI run from its command through pages and extractors, and its logs carry the trace ID", async () => {
        await new Promise<void>((resolve) => execFile(process.execPath, ["--experimental-strip-types", CLI, "audit", `${site.origin}/about`, "--max-pages", "2", "--no-sitemap", "--rules", "html-validate", "--fail-on", "never", "--no-cache"], { cwd: directory, env: environment() }, () => resolve()));
        const root = otlp.received.spans.find((span) => span.name === "spiderlint audit");
        assert.ok(root, otlp.received.spans.map((span) => span.name).join(", "));
        const inTrace = otlp.received.spans.filter((span) => span.traceId === root.traceId);
        assert.ok(inTrace.some((span) => span.name === "page"));
        assert.ok(inTrace.some((span) => span.name === "extract htmlvalidate"));
        assert.ok(otlp.received.logTraces.includes(root.traceId), "a log record carries the run’s trace ID");
        assert.ok(otlp.received.metrics.includes("spiderlint.extractor.duration"), otlp.received.metrics.join(", "));
    });

    it("continues the worker’s trace in the scan runner from the carrier on stdin", async () => {
        const [traceId, parent] = ["4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"];
        const child = spawn(process.execPath, ["--experimental-strip-types", RUNNER], { cwd: directory, env: environment(), stdio: ["pipe", "ignore", "ignore", "pipe"] });
        child.stdin?.end(JSON.stringify({ url: `${site.origin}/about`, settings: { "max-pages": 1, sitemap: false, rules: [] }, deny: [], trace: { traceparent: `00-${traceId}-${parent}-01` } }));
        await new Promise((resolve) => child.once("close", resolve));
        const scan = otlp.received.spans.find((span) => span.name === "scan" && span.traceId === traceId);
        assert.equal(scan?.parentSpanId, parent);
        assert.ok(otlp.received.spans.some((span) => span.name === "page" && span.traceId === traceId));
    });
});
