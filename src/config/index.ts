// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { BucketName, CacheMode } from "../cache/index.ts";
import type { Pin } from "../crawl/resolve.ts";
import type { Scope } from "../crawl/scope.ts";
import { log } from "../logger.ts";
import type { RulesetConfig, Severity } from "../rules/types.ts";

export type FetchMode = "auto" | "http" | "browser" | "adaptive";
export type BrowserName = "chromium" | "firefox" | "webkit";
export type FailOn = "error" | "warning" | "info" | "never";

export interface GroupConfig {
    match?: string[];
    rules?: string[];
    fetch?: FetchMode;
    // Pages per group an expensive extractor runs on; `all` runs it on every page.
    sample?: number | "all";
}

export interface FoldConfig {
    threshold: number;
    min: number;
}

export interface Config {
    seeds: string[];
    canonicalOrigin?: string;
    fetch: FetchMode;
    browser: BrowserName;
    scope: Scope;
    // Pages or requests in flight; 0 is NUMPROCS, halved for a browser, one beside an expensive browser extractor.
    concurrency: number;
    // Requests per minute; 0 is unlimited.
    rate: number;
    // Seconds one page may take, its navigation half of it.
    timeout: number;
    // A named bundle of settings over the defaults, as `PROFILES` holds; empty is none.
    profile: string;
    // `http`, `https` or `socks*` proxy URL every request goes through; empty goes direct.
    proxy: string;
    maxPages: number;
    maxDepth: number;
    maxBodySize: number;
    keepalive: boolean;
    fetchResources: boolean;
    maxResourcesPerPage: number;
    // Hosts, each with its subdomains, whose off-scope links are never probed.
    linkExclude: string[];
    includeUrls: string[];
    excludeUrls: string[];
    robots: boolean;
    sitemap: boolean;
    fold: FoldConfig | false;
    failOn: FailOn;
    // A built-in format or one a loaded plugin adds.
    format: string;
    excludeRules: string[];
    overrides: Record<string, Exclude<Severity, "off">>;
    rules?: string[];
    groups: Record<string, GroupConfig>;
    rulesets: Record<string, RulesetConfig>;
    plugins: string[];
    // `<id>:<argument>` per plugin source whose URLs join the seeds.
    sources: string[];
    // Whether links and sitemap URLs join the seeds; a source that does not follow clears it.
    follow: boolean;
    cacheMode: CacheMode;
    cacheTtl: Partial<Record<BucketName, number>>;
    // Whether site extractor probes may reach loopback, private and link-local addresses, and query name servers directly.
    allowPrivate: boolean;
    // `system`, or a comma list of `address[:port]` the dns plugin and the crawl query.
    resolver: string;
    // Names pinned to an address for every crawl connection, as curl’s `--resolve`.
    resolve: Pin[];
    // `org.spiderlint.<plugin>` keys, validated against each plugin’s schema once plugins load.
    pluginSettings: Record<string, unknown>;
}

export function defaults(): Config {
    return {
        seeds: [],
        fetch: "auto",
        browser: "chromium",
        scope: "origin",
        concurrency: 0,
        rate: 0,
        timeout: 60,
        profile: "",
        proxy: "",
        maxPages: 0,
        maxDepth: 0,
        maxBodySize: 10_000_000,
        keepalive: true,
        fetchResources: true,
        maxResourcesPerPage: 200,
        linkExclude: [],
        includeUrls: [],
        excludeUrls: [],
        robots: true,
        sitemap: true,
        fold: { threshold: 0.8, min: 3 },
        failOn: "error",
        format: "human",
        excludeRules: [],
        overrides: {},
        groups: {},
        rulesets: {},
        plugins: [],
        sources: [],
        follow: true,
        cacheMode: "use",
        cacheTtl: {},
        allowPrivate: true,
        resolver: "system",
        resolve: [],
        pluginSettings: {},
    };
}

// Settings a profile lays over the defaults; `adaptive: false` resolves an adaptive group as `auto`.
export const PROFILES: Record<string, Partial<Pick<Config, "concurrency" | "timeout" | "proxy">> & { adaptive?: false }> = {
    tor: { concurrency: 4, timeout: 240, adaptive: false, proxy: "socks5h://127.0.0.1:9050" },
    i2p: { concurrency: 4, timeout: 240, adaptive: false, proxy: "http://127.0.0.1:4444" },
};

// Thrown for anything that maps to exit code 2.
export class ConfigError extends Error {}

// The origin of an absolute http(s) URL; anything else names `name` in the error.
export function originOf(name: string, raw: string): string {
    const url = URL.canParse(raw) ? new URL(raw) : undefined;
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new ConfigError(`${name}: invalid value ${raw} (expected an absolute http or https URL)`);
    return url.origin;
}

// A proxy URL of a scheme every client can use, or empty for none; anything else names `name` in the error.
export function proxyOf(name: string, raw: string): string {
    const url = URL.canParse(raw) ? new URL(raw) : undefined;
    const isValid = raw === "" || ["http:", "https:", "socks:", "socks4:", "socks4a:", "socks5:", "socks5h:"].includes(url?.protocol ?? "");
    if (!isValid) throw new ConfigError(`${name}: invalid value ${raw} (expected an http, https, socks4, socks4a, socks5 or socks5h URL)`);
    return raw;
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

// `patches` over the defaults, lowest first, with the profile they name laid in between.
export function layered(patches: Partial<Config>[]): Config {
    const merge = (base: Config) => {
        let merged = base;
        for (const patch of patches) merged = overlay(merged, patch);
        return merged;
    };
    const { profile } = merge(defaults());
    const { adaptive, ...bundle } = PROFILES[profile] ?? {};
    log.debug({ profile, bundle, adaptive }, "profile applied");
    return merge(overlay(defaults(), bundle));
}
