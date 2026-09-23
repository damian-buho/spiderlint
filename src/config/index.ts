// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Scope } from "../crawl/scope.ts";
import type { RulesetConfig, Severity } from "../rules/types.ts";

export type FetchMode = "auto" | "http" | "browser" | "adaptive";
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
    fetch: FetchMode;
    scope: Scope;
    maxPages: number;
    maxDepth: number;
    maxBodySize: number;
    keepalive: boolean;
    include: string[];
    exclude: string[];
    robots: boolean;
    sitemap: boolean;
    fold: FoldConfig | false;
    failOn: FailOn;
    format: Format;
    disabledRules: string[];
    overrides: Record<string, Exclude<Severity, "off">>;
    groups: Record<string, GroupConfig>;
    rulesets: Record<string, RulesetConfig>;
}

export function defaults(): Config {
    return {
        seeds: [],
        fetch: "http",
        scope: "origin",
        maxPages: 0,
        maxDepth: 0,
        maxBodySize: 10_000_000,
        keepalive: true,
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
    };
}

// Thrown for anything that maps to exit code 2.
export class ConfigError extends Error {}

// Applies every defined key of `patch` over `base`; undefined keys leave `base` untouched.
// This is the merge step of the flags > env > file > defaults precedence ladder.
export function overlay<T extends object>(base: T, patch: Partial<T>): T {
    const merged = { ...base };
    for (const key of Object.keys(patch) as (keyof T)[]) {
        if (patch[key] !== undefined) merged[key] = patch[key] as T[keyof T];
    }
    return merged;
}
