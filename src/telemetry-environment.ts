// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// The OTLP endpoint variables; any one set switches telemetry on.
export const ENDPOINTS = ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"];

// Whether the environment names an OTLP endpoint and does not disable the SDK.
export function isTelemetryConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.OTEL_SDK_DISABLED !== "true" && ENDPOINTS.some((name) => (environment[name] ?? "") !== "");
}
