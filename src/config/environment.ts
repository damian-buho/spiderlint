// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseResolver } from "../crawl/dns.ts";
import { parsePin } from "../crawl/resolve.ts";
import { ConfigError, PROFILES, ROLES, originOf, proxyOf, type FailOn } from "./index.ts";
import type { Settings } from "./policy.ts";

export const FETCH_MODES = ["auto", "http", "browser", "adaptive"] as const;
export const BROWSERS = ["chromium", "firefox", "webkit"] as const;
export const SCOPES = ["origin", "host", "domain"] as const;
export const FAIL_ONS = ["error", "warning", "info", "never"] as const;
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

export function parseInteger(name: string, raw: string): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new ConfigError(`${name}: invalid value ${raw} (expected a non-negative integer)`);
    return value;
}

export function pick<T extends string>(name: string, raw: string, valid: readonly T[]): T {
    if (!valid.includes(raw as T)) throw new ConfigError(`${name}: invalid value ${raw} (expected: ${valid.join("|")})`);
    return raw as T;
}

// A level or `never`, or the lowest score, 0.1 to 9.9, that fails the run.
export function parseFailOn(name: string, raw: string): FailOn {
    const score = Number(raw);
    if (raw.trim() === "" || Number.isNaN(score)) return pick(name, raw, FAIL_ONS);
    if (score < 0.1 || score > 9.9) throw new ConfigError(`${name}: invalid score ${raw} (expected 0.1 to 9.9)`);
    return score;
}

// One severity bucket of rule IDs, as `SPIDERLINT_OVERRIDE_ERROR` etc. carry it.
function overrideBucket(raw: string | undefined, severity: "error" | "warning" | "info" | "hint"): Record<string, "error" | "warning" | "info" | "hint"> {
    return raw === undefined ? {} : Object.fromEntries(list(raw).map((id) => [id, severity]));
}

// SPIDERLINT_* mirrors each flag (AGENTS.md ## Configuration, ## Rules); only set variables apply.
export function environmentSettings(environment: NodeJS.ProcessEnv): Settings {
    const overrideVariables = [environment.SPIDERLINT_OVERRIDE_ERROR, environment.SPIDERLINT_OVERRIDE_WARNING, environment.SPIDERLINT_OVERRIDE_INFO, environment.SPIDERLINT_OVERRIDE_HINT];
    return {
        ...(environment.SPIDERLINT_TARGETS !== undefined && { seeds: list(environment.SPIDERLINT_TARGETS) }),
        ...(environment.SPIDERLINT_CANONICAL_ORIGIN !== undefined && { canonicalOrigin: originOf("SPIDERLINT_CANONICAL_ORIGIN", environment.SPIDERLINT_CANONICAL_ORIGIN) }),
        ...(environment.SPIDERLINT_ROLE !== undefined && { role: pick("SPIDERLINT_ROLE", environment.SPIDERLINT_ROLE, ROLES) }),
        ...(environment.SPIDERLINT_RESOLVER !== undefined && { resolver: parseResolver(environment.SPIDERLINT_RESOLVER) }),
        ...(environment.SPIDERLINT_RESOLVE !== undefined && { resolve: list(environment.SPIDERLINT_RESOLVE).map((pin) => parsePin(pin)) }),
        ...(environment.SPIDERLINT_FETCH !== undefined && { fetch: pick("SPIDERLINT_FETCH", environment.SPIDERLINT_FETCH, FETCH_MODES) }),
        ...(environment.SPIDERLINT_BROWSER !== undefined && { browser: pick("SPIDERLINT_BROWSER", environment.SPIDERLINT_BROWSER, BROWSERS) }),
        ...(environment.SPIDERLINT_BROWSER_INSTALL !== undefined && { browserInstall: isTruthy("SPIDERLINT_BROWSER_INSTALL", environment.SPIDERLINT_BROWSER_INSTALL) }),
        ...(environment.SPIDERLINT_SCOPE !== undefined && { scope: pick("SPIDERLINT_SCOPE", environment.SPIDERLINT_SCOPE, SCOPES) }),
        ...(environment.SPIDERLINT_CONCURRENCY !== undefined && { concurrency: parseInteger("SPIDERLINT_CONCURRENCY", environment.SPIDERLINT_CONCURRENCY) }),
        ...(environment.SPIDERLINT_RATE !== undefined && { rate: parseInteger("SPIDERLINT_RATE", environment.SPIDERLINT_RATE) }),
        ...(environment.SPIDERLINT_TIMEOUT !== undefined && { timeout: parseInteger("SPIDERLINT_TIMEOUT", environment.SPIDERLINT_TIMEOUT) }),
        ...(environment.SPIDERLINT_PROFILE !== undefined && { profile: pick("SPIDERLINT_PROFILE", environment.SPIDERLINT_PROFILE, Object.keys(PROFILES)) }),
        ...(environment.SPIDERLINT_PROXY !== undefined && { proxy: proxyOf("SPIDERLINT_PROXY", environment.SPIDERLINT_PROXY) }),
        ...(environment.SPIDERLINT_MAX_PAGES !== undefined && { maxPages: parseInteger("SPIDERLINT_MAX_PAGES", environment.SPIDERLINT_MAX_PAGES) }),
        ...(environment.SPIDERLINT_MAX_DEPTH !== undefined && { maxDepth: parseInteger("SPIDERLINT_MAX_DEPTH", environment.SPIDERLINT_MAX_DEPTH) }),
        ...(environment.SPIDERLINT_MAX_BODY_SIZE !== undefined && { maxBodySize: parseInteger("SPIDERLINT_MAX_BODY_SIZE", environment.SPIDERLINT_MAX_BODY_SIZE) }),
        ...(environment.SPIDERLINT_KEEPALIVE !== undefined && { keepalive: isTruthy("SPIDERLINT_KEEPALIVE", environment.SPIDERLINT_KEEPALIVE) }),
        ...(environment.SPIDERLINT_ALLOW_PRIVATE !== undefined && { allowPrivate: isTruthy("SPIDERLINT_ALLOW_PRIVATE", environment.SPIDERLINT_ALLOW_PRIVATE) }),
        ...(environment.SPIDERLINT_RESOURCES !== undefined && { fetchResources: isTruthy("SPIDERLINT_RESOURCES", environment.SPIDERLINT_RESOURCES) }),
        ...(environment.SPIDERLINT_RULES !== undefined && { rules: list(environment.SPIDERLINT_RULES) }),
        ...(environment.SPIDERLINT_SOURCES !== undefined && { sources: list(environment.SPIDERLINT_SOURCES) }),
        ...(environment.SPIDERLINT_INCLUDE_URLS !== undefined && { includeUrls: list(environment.SPIDERLINT_INCLUDE_URLS) }),
        ...(environment.SPIDERLINT_EXCLUDE_URLS !== undefined && { excludeUrls: list(environment.SPIDERLINT_EXCLUDE_URLS) }),
        ...(environment.SPIDERLINT_ROBOTS !== undefined && { robots: isTruthy("SPIDERLINT_ROBOTS", environment.SPIDERLINT_ROBOTS) }),
        ...(environment.SPIDERLINT_SITEMAP !== undefined && { sitemap: isTruthy("SPIDERLINT_SITEMAP", environment.SPIDERLINT_SITEMAP) }),
        ...(environment.SPIDERLINT_FOLD !== undefined && { fold: isTruthy("SPIDERLINT_FOLD", environment.SPIDERLINT_FOLD) && { threshold: 0.8, min: 3 } }),
        ...(environment.SPIDERLINT_FAIL_ON !== undefined && { failOn: parseFailOn("SPIDERLINT_FAIL_ON", environment.SPIDERLINT_FAIL_ON) }),
        ...(environment.SPIDERLINT_FORMAT !== undefined && { format: environment.SPIDERLINT_FORMAT }),
        ...(environment.SPIDERLINT_CACHE !== undefined && { cacheMode: pick("SPIDERLINT_CACHE", environment.SPIDERLINT_CACHE, CACHE_MODES) }),
        ...(environment.SPIDERLINT_EXCLUDE_RULES !== undefined && { excludeRules: list(environment.SPIDERLINT_EXCLUDE_RULES) }),
        ...(overrideVariables.some((value) => value !== undefined) && {
            overrides: { ...overrideBucket(environment.SPIDERLINT_OVERRIDE_ERROR, "error"), ...overrideBucket(environment.SPIDERLINT_OVERRIDE_WARNING, "warning"), ...overrideBucket(environment.SPIDERLINT_OVERRIDE_INFO, "info"), ...overrideBucket(environment.SPIDERLINT_OVERRIDE_HINT, "hint") },
        }),
    };
}
