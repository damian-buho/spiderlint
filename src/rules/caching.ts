// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import picomatch from "picomatch";
import { ConfigError } from "../config/index.ts";
import { parseCacheControl } from "../facts/headers.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "./message.ts";
import type { Datum, Finding, Make } from "./types.ts";

const ID = "caching/long-without-hash";

interface CachingSettings {
    // Seconds of freshness past which a URL must change with its content.
    threshold: number;
    // Globs, or `re:` regexes, over path and query that mark a URL as versioned, beside the built-in ones.
    entropy: string[];
    // Globs, or `re:` regexes, over path and query of files that never change by design.
    allow: string[];
}

const DEFAULTS: CachingSettings = { threshold: 2_592_000, entropy: [], allow: [] };

// Build directories whose every file name a framework fingerprints.
const BUILD_DIRECTORIES = ["/_astro/**", "/_next/static/**", "/_nuxt/**", "/_app/immutable/**"];

// A path token holding a content hash or version: 6+ hex with a digit and a letter, 8+ word characters with a digit, or a dotted version.
const HASH = /(?:^|[/._~-])(?:(?=[a-f\d]*\d)(?=[a-f\d]*[a-f])[a-f\d]{6,}|(?=[a-z\d]*\d)[a-z\d]{8,}|v?\d+\.\d+(?:\.\d+)*)(?=$|[/._~-])/i;

// `re:` is a regex, anything else a picomatch glob, both over path and query.
function matcher(entry: string): (target: string) => boolean {
    if (!entry.startsWith("re:")) return picomatch(entry);
    try {
        const regex = new RegExp(entry.slice(3));
        return (target) => regex.test(target);
    } catch (error) {
        throw new ConfigError(`rule ${ID}: ${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// One URL the crawl recorded headers for, with how many pages use it.
interface Served {
    url: string;
    type: string;
    policy: string;
    users: number;
}

// A response’s Cache-Control, repeated fields joined; absent is empty.
function policyOf(headers: Record<string, string | string[]> | undefined): string {
    return [headers?.["cache-control"] ?? []].flat().join(", ");
}

// Every 2xx page and resource once, by URL; a page counts its referrers, a resource the pages loading it.
function served(pages: Facts[]): Served[] {
    const byUrl = new Map<string, Served>();
    const resources = pages.flatMap((page) => page.resources ?? []);
    for (const page of pages) {
        if (page.http.status >= 200 && page.http.status < 300) byUrl.set(page.url.href, { url: page.url.href, type: page.http["content-type"], policy: policyOf(page.http.headers), users: page.crawl.referrers.length });
    }
    for (const resource of resources) {
        const status = resource.http?.status ?? 0;
        if (status < 200 || status >= 300) continue;
        const known = byUrl.get(resource.url);
        byUrl.set(resource.url, known ? { ...known, users: known.users + 1 } : { url: resource.url, type: resource.http?.["content-type"] ?? "", policy: policyOf(resource.http?.headers), users: 1 });
    }
    return byUrl.values().toArray();
}

// `immutable`, or the longer of `max-age` and `s-maxage` past the threshold; `no-cache` and `no-store` revalidate, and a broken header is another rule’s.
function lifetime(policy: string, threshold: number): "immutable" | "long" | undefined {
    if (!policy) return undefined;
    const { value, errors } = parseCacheControl(policy);
    const directives = (value ?? {}) as Record<string, unknown>;
    if (errors.length > 0 || directives["no-cache"] !== undefined || directives["no-store"] !== undefined) return undefined;
    if (directives.immutable !== undefined) return "immutable";
    return Math.max(Number(directives["max-age"] ?? 0), Number(directives["s-maxage"] ?? 0)) > threshold ? "long" : undefined;
}

const SENTENCES = {
    immutable: "{type} files are sent immutable at URLs that carry no hash or version, so caches serve a stale copy after the next publish",
    long: "{type} files are cached long at URLs that carry no hash or version, so caches serve a stale copy after the next publish",
};

// One finding per media type and kind of promise, listing every long-cached URL that cannot change with its content.
const longWithoutHash: Make = (severity, expect) => {
    const settings = { ...DEFAULTS, ...(expect as Partial<CachingSettings>) };
    const versioned = [...BUILD_DIRECTORIES, ...settings.entropy].map((entry) => matcher(entry));
    const allowed = settings.allow.map((entry) => matcher(entry));
    return {
        meta: {
            id: ID,
            severity,
            scope: "site",
            facts: ["http.headers.cache-control", "resources"],
            docs: "https://www.rfc-editor.org/rfc/rfc8246",
            fix: "Put a content hash or version in the file name, as cv.3f9a1c.pdf, or send Cache-Control: no-cache.",
        },
        check(pages: Facts[]) {
            const flagged = new Map<string, Served[]>();
            for (const entry of served(pages)) {
                const promise = lifetime(entry.policy, settings.threshold);
                if (!promise) continue;
                const url = new URL(entry.url);
                const target = url.pathname + url.search;
                const isVersioned = url.search.length > 1 || HASH.test(url.pathname) || versioned.some((match) => match(target));
                const isAllowed = allowed.some((match) => match(target));
                log.debug({ rule: ID, url: entry.url, policy: entry.policy, promise, isVersioned, isAllowed }, "cache lifetime judged");
                if (isVersioned || isAllowed) continue;
                const key = `${promise}\t${entry.type || "none"}`;
                flagged.set(key, [...(flagged.get(key) ?? []), entry]);
            }
            log.debug({ rule: ID, threshold: settings.threshold, groups: flagged.keys().toArray() }, "long-cached URLs grouped by type");
            return [...flagged].map(([key, entries]): Finding => {
                const [promise, type] = key.split("\t") as ["immutable" | "long", string];
                const data = Object.fromEntries(entries.map((entry) => [entry.url, { "cache-control": entry.policy, pages: entry.users } satisfies Record<string, Datum>]));
                return { rule: ID, severity: promise === "immutable" && severity === "warning" ? "error" : severity, scope: "site", url: entries[0]?.url as string, ...said(SENTENCES[promise], { type }), data, value: type, urls: entries.map((entry) => entry.url) };
            });
        },
    };
};

export const cachingRules: Record<string, Make> = { [ID]: longWithoutHash };
