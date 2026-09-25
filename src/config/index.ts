// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { BucketName, CacheMode } from "../cache/index.ts";
import type { Scope } from "../crawl/scope.ts";
import type { RulesetConfig, Severity } from "../rules/types.ts";

export type FetchMode = "auto" | "http" | "browser" | "adaptive";
export type BrowserName = "chromium" | "firefox" | "webkit";
export type FailOn = "error" | "warning" | "info" | "never";

export interface GroupConfig {
    match?: string[];
    rules?: string[];
    fetch?: FetchMode;
}

export interface FoldConfig {
    threshold: number;
    min: number;
}

export type Format = "human" | "json" | "sarif";

export interface Config {
    seeds: string[];
    canonicalOrigin?: string;
    fetch: FetchMode;
    browser: BrowserName;
    scope: Scope;
    maxPages: number;
    maxDepth: number;
    maxBodySize: number;
    keepalive: boolean;
    fetchResources: boolean;
    maxResourcesPerPage: number;
    include: string[];
    exclude: string[];
    robots: boolean;
    sitemap: boolean;
    fold: FoldConfig | false;
    failOn: FailOn;
    format: Format;
    disabledRules: string[];
    overrides: Record<string, Exclude<Severity, "off">>;
    rules?: string[];
    groups: Record<string, GroupConfig>;
    rulesets: Record<string, RulesetConfig>;
    plugins: string[];
    cacheMode: CacheMode;
    cacheTtl: Partial<Record<BucketName, number>>;
    // Whether site extractor probes may reach loopback, private and link-local addresses.
    allowPrivate: boolean;
}

export function defaults(): Config {
    return {
        seeds: [],
        fetch: "auto",
        browser: "chromium",
        scope: "origin",
        maxPages: 0,
        maxDepth: 0,
        maxBodySize: 10_000_000,
        keepalive: true,
        fetchResources: true,
        maxResourcesPerPage: 200,
        include: [],
        exclude: [],
        robots: true,
        sitemap: true,
        fold: { threshold: 0.8, min: 3 },
        failOn: "error",
        format: "human",
        disabledRules: [],
        overrides: {},
        groups: {},
        rulesets: {},
        plugins: [],
        cacheMode: "use",
        cacheTtl: {},
        allowPrivate: true,
    };
}

// Thrown for anything that maps to exit code 2.
export class ConfigError extends Error {}

// The origin of an absolute http(s) URL; anything else names `name` in the error.
export function originOf(name: string, raw: string): string {
    const url = URL.canParse(raw) ? new URL(raw) : undefined;
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new ConfigError(`${name}: invalid value ${raw} (expected an absolute http or https URL)`);
    return url.origin;
}

// Applies every defined key of `patch` over `base`; undefined keys leave `base` untouched.
// This is the merge step of the flags > env > file > defaults precedence ladder.
export function overlay<T extends object>(base: T, patch: Partial<T>): T {
    const merged = { ...base };
    for (const key of Object.keys(patch) as (keyof T)[]) {
        if (patch[key] !== undefined) merged[key] = patch[key] as T[keyof T];
    }
    return merged;
}
