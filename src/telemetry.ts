// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { context, metrics, propagation, SpanStatusCode, trace, type Attributes, type Counter, type Histogram, type ObservableGauge, type Span } from "@opentelemetry/api";
import { VERSION } from "./agent.ts";
import { log } from "./logger.ts";
import { ENDPOINTS, isTelemetryConfigured } from "./telemetry-environment.ts";

// Milliseconds between metric exports; OTEL_METRIC_EXPORT_INTERVAL overrides it.
const EXPORT_MS = 15_000;

// Instruments, created once the meter provider exists, since a meter taken before it stays a no-op.
interface Instruments {
    requests: Counter;
    refusals: Counter;
    scanDuration: Histogram;
    scanPages: Histogram;
    extractorDuration: Histogram;
    queueDepth: ObservableGauge;
}

const state: { instruments?: Instruments } = {};

const tracer = trace.getTracer("spiderlint", VERSION);

export interface Telemetry {
    shutdown(): Promise<void>;
}

// Starts OTLP trace and metric export for `service` when an endpoint is set; unset, nothing is imported and undefined comes back.
export async function startTelemetry(service: string): Promise<Telemetry | undefined> {
    if (!isTelemetryConfigured()) {
        log.debug({ service, variables: ENDPOINTS }, "telemetry off, no OTLP endpoint set");
        return undefined;
    }
    const [{ NodeTracerProvider, BatchSpanProcessor }, { MeterProvider, PeriodicExportingMetricReader }, { OTLPTraceExporter }, { OTLPMetricExporter }, { resourceFromAttributes }] = await Promise.all([
        import("@opentelemetry/sdk-trace-node"),
        import("@opentelemetry/sdk-metrics"),
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/exporter-metrics-otlp-http"),
        import("@opentelemetry/resources"),
    ]);
    const name = process.env.OTEL_SERVICE_NAME || service;
    const resource = resourceFromAttributes({ "service.name": name, "service.version": VERSION });
    const tracing = new NodeTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
    tracing.register();
    const interval = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || EXPORT_MS;
    const metering = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: interval })] });
    metrics.setGlobalMeterProvider(metering);
    const meter = metrics.getMeter("spiderlint", VERSION);
    state.instruments = {
        requests: meter.createCounter("spiderlint.http.requests", { description: "API requests by route, method and status" }),
        refusals: meter.createCounter("spiderlint.refusals", { description: "Refused API requests by code" }),
        scanDuration: meter.createHistogram("spiderlint.scan.duration", { description: "Scan wall time by outcome", unit: "s" }),
        scanPages: meter.createHistogram("spiderlint.scan.pages", { description: "Pages per finished scan" }),
        extractorDuration: meter.createHistogram("spiderlint.extractor.duration", { description: "Time per extractor run", unit: "ms" }),
        queueDepth: meter.createObservableGauge("spiderlint.queue.depth", { description: "Scans by queue state" }),
    };
    log.info({ service: name, interval }, "telemetry on, exporting traces and metrics over OTLP");
    return {
        async shutdown() {
            await Promise.allSettled([tracing.shutdown(), metering.shutdown()]);
            log.debug({ service: name }, "telemetry flushed");
        },
    };
}

// Runs `work` inside a new active span, recording a throw as its error; a no-op span when telemetry is off.
export async function inSpan<T>(name: string, attributes: Attributes, work: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
            return await work(span);
        } catch (error) {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            throw error;
        } finally {
            span.end();
        }
    });
}

// Renames the active span once its subject is known, as the CLI’s command.
export function nameSpan(name: string): void {
    trace.getActiveSpan()?.updateName(name);
}

// The active trace context as W3C headers, to carry through the queue and into a scan runner; empty when telemetry is off.
export function traceCarrier(): Record<string, string> {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return carrier;
}

// Runs `work` as a continuation of the trace `carrier` names.
export function withTraceCarrier<T>(carrier: Record<string, string> | undefined, work: () => T): T {
    return context.with(propagation.extract(context.active(), carrier ?? {}), work);
}

// Counts one API request.
export function countRequest(route: string, method: string, status: number): void {
    state.instruments?.requests.add(1, { "http.route": route, "http.request.method": method, "http.response.status_code": status });
}

// Counts one refusal by its code: invalid bodies, policy refusals, rate windows and client buckets alike.
export function countRefusal(code: string): void {
    state.instruments?.refusals.add(1, { code });
}

// Records one finished or failed scan.
export function recordScan(seconds: number, outcome: "done" | "failed", pages?: number): void {
    state.instruments?.scanDuration.record(seconds, { outcome });
    if (pages !== undefined) state.instruments?.scanPages.record(pages);
}

// Records one extractor run.
export function recordExtractor(id: string, ms: number): void {
    state.instruments?.extractorDuration.record(ms, { extractor: id });
}

// Reports queue depth by state from `read` on every metric export.
export function observeQueue(read: () => Promise<Record<string, number>>): void {
    state.instruments?.queueDepth.addCallback(async (result) => {
        const counts = await read();
        for (const [name, count] of Object.entries(counts)) result.observe(count, { state: name });
    });
}
