// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Scope } from "../crawl/scope.ts";
import type { RulesetConfig } from "../rules/types.ts";

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

export interface Config {
    seeds: string[];
    fetch: FetchMode;
    scope: Scope;
    maxPages: number;
    maxDepth: number;
    include: string[];
    exclude: string[];
    robots: boolean;
    sitemap: boolean;
    fold: FoldConfig | false;
    failOn: FailOn;
    groups: Record<string, GroupConfig>;
    rulesets: Record<string, RulesetConfig>;
}

// Skeleton defaults; the org.spiderlint subtree via pf-cli replaces this.
export function defaults(): Config {
    return {
        seeds: [],
        fetch: "http",
        scope: "origin",
        maxPages: 0,
        maxDepth: 0,
        include: [],
        exclude: [],
        robots: true,
        sitemap: true,
        fold: { threshold: 0.8, min: 3 },
        failOn: "error",
        groups: {},
        rulesets: {},
    };
}

// Thrown for anything that maps to exit code 2.
export class ConfigError extends Error {}
