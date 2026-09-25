// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseResolver } from "../crawl/dns.ts";
import { ConfigError, originOf, proxyOf } from "./index.ts";
import type { Settings } from "./policy.ts";

const FETCH_MODES = ["auto", "http", "browser", "adaptive"] as const;
const BROWSERS = ["chromium", "firefox", "webkit"] as const;
const SCOPES = ["origin", "host", "domain"] as const;
const FAIL_ONS = ["error", "warning", "info", "never"] as const;
const FORMATS = ["human", "json", "sarif"] as const;
const CACHE_MODES = ["use", "off", "refresh", "offline"] as const;

function isTruthy(name: string, raw: string): boolean {
    const value = raw.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(value)) return true;
    if (["0", "false", "no", "n", "off"].includes(value)) return false;
    throw new ConfigError(`${name}: invalid value ${raw} (expected a boolean)`);
}

function list(raw: string): string[] {
    return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

function parseInteger(name: string, raw: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new ConfigError(`${name}: invalid value ${raw} (expected a non-negative integer)`);
    return value;
}

function pick<T extends string>(name: string, raw: string, valid: readonly T[]): T {
    if (!valid.includes(raw as T)) throw new ConfigError(`${name}: invalid value ${raw} (expected: ${valid.join("|")})`);
    return raw as T;
}

// One severity bucket of rule IDs, as `SPIDERLINT_OVERRIDE_ERROR` etc. carry it.
function overrideBucket(raw: string | undefined, severity: "error" | "warning" | "info"): Record<string, "error" | "warning" | "info"> {
    return raw === undefined ? {} : Object.fromEntries(list(raw).map((id) => [id, severity]));
}

// SPIDERLINT_* mirrors each flag (AGENTS.md ## Configuration, ## Rules); only set variables apply.
export function environmentSettings(environment: NodeJS.ProcessEnv): Settings {
    const overrideVariables = [environment.SPIDERLINT_OVERRIDE_ERROR, environment.SPIDERLINT_OVERRIDE_WARNING, environment.SPIDERLINT_OVERRIDE_INFO];
    return {
        ...(environment.SPIDERLINT_TARGETS !== undefined && { seeds: list(environment.SPIDERLINT_TARGETS) }),
        ...(environment.SPIDERLINT_CANONICAL_ORIGIN !== undefined && { canonicalOrigin: originOf("SPIDERLINT_CANONICAL_ORIGIN", environment.SPIDERLINT_CANONICAL_ORIGIN) }),
        ...(environment.SPIDERLINT_RESOLVER !== undefined && { resolver: parseResolver(environment.SPIDERLINT_RESOLVER) }),
        ...(environment.SPIDERLINT_FETCH !== undefined && { fetch: pick("SPIDERLINT_FETCH", environment.SPIDERLINT_FETCH, FETCH_MODES) }),
        ...(environment.SPIDERLINT_BROWSER !== undefined && { browser: pick("SPIDERLINT_BROWSER", environment.SPIDERLINT_BROWSER, BROWSERS) }),
        ...(environment.SPIDERLINT_SCOPE !== undefined && { scope: pick("SPIDERLINT_SCOPE", environment.SPIDERLINT_SCOPE, SCOPES) }),
        ...(environment.SPIDERLINT_CONCURRENCY !== undefined && { concurrency: parseInteger("SPIDERLINT_CONCURRENCY", environment.SPIDERLINT_CONCURRENCY) }),
        ...(environment.SPIDERLINT_RATE !== undefined && { rate: parseInteger("SPIDERLINT_RATE", environment.SPIDERLINT_RATE) }),
        ...(environment.SPIDERLINT_PROXY !== undefined && { proxy: proxyOf("SPIDERLINT_PROXY", environment.SPIDERLINT_PROXY) }),
        ...(environment.SPIDERLINT_MAX_PAGES !== undefined && { maxPages: parseInteger("SPIDERLINT_MAX_PAGES", environment.SPIDERLINT_MAX_PAGES) }),
        ...(environment.SPIDERLINT_MAX_DEPTH !== undefined && { maxDepth: parseInteger("SPIDERLINT_MAX_DEPTH", environment.SPIDERLINT_MAX_DEPTH) }),
        ...(environment.SPIDERLINT_MAX_BODY_SIZE !== undefined && { maxBodySize: parseInteger("SPIDERLINT_MAX_BODY_SIZE", environment.SPIDERLINT_MAX_BODY_SIZE) }),
        ...(environment.SPIDERLINT_KEEPALIVE !== undefined && { keepalive: isTruthy("SPIDERLINT_KEEPALIVE", environment.SPIDERLINT_KEEPALIVE) }),
        ...(environment.SPIDERLINT_RESOURCES !== undefined && { fetchResources: isTruthy("SPIDERLINT_RESOURCES", environment.SPIDERLINT_RESOURCES) }),
        ...(environment.SPIDERLINT_RULES !== undefined && { rules: list(environment.SPIDERLINT_RULES) }),
        ...(environment.SPIDERLINT_INCLUDE !== undefined && { include: list(environment.SPIDERLINT_INCLUDE) }),
        ...(environment.SPIDERLINT_EXCLUDE !== undefined && { exclude: list(environment.SPIDERLINT_EXCLUDE) }),
        ...(environment.SPIDERLINT_ROBOTS !== undefined && { robots: isTruthy("SPIDERLINT_ROBOTS", environment.SPIDERLINT_ROBOTS) }),
        ...(environment.SPIDERLINT_SITEMAP !== undefined && { sitemap: isTruthy("SPIDERLINT_SITEMAP", environment.SPIDERLINT_SITEMAP) }),
        ...(environment.SPIDERLINT_FOLD !== undefined && { fold: isTruthy("SPIDERLINT_FOLD", environment.SPIDERLINT_FOLD) && { threshold: 0.8, min: 3 } }),
        ...(environment.SPIDERLINT_FAIL_ON !== undefined && { failOn: pick("SPIDERLINT_FAIL_ON", environment.SPIDERLINT_FAIL_ON, FAIL_ONS) }),
        ...(environment.SPIDERLINT_FORMAT !== undefined && { format: pick("SPIDERLINT_FORMAT", environment.SPIDERLINT_FORMAT, FORMATS) }),
        ...(environment.SPIDERLINT_CACHE !== undefined && { cacheMode: pick("SPIDERLINT_CACHE", environment.SPIDERLINT_CACHE, CACHE_MODES) }),
        ...(environment.SPIDERLINT_DISABLED_RULES !== undefined && { disabledRules: list(environment.SPIDERLINT_DISABLED_RULES) }),
        ...(overrideVariables.some((value) => value !== undefined) && {
            overrides: { ...overrideBucket(environment.SPIDERLINT_OVERRIDE_ERROR, "error"), ...overrideBucket(environment.SPIDERLINT_OVERRIDE_WARNING, "warning"), ...overrideBucket(environment.SPIDERLINT_OVERRIDE_INFO, "info") },
        }),
    };
}
