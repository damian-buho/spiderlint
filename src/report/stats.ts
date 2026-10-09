// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { byRank, flatten } from "../facts/flatten.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";

export interface Stat {
    count: number;
    min: number;
    median: number;
    p95: number;
    max: number;
    // Absent where a sum means nothing: a configured limit, a depth.
    total?: number;
}

// Numbers that name something rather than measure it.
const NOMINAL = new Set(["http.status", "co2.version"]);

// Numbers a total of means nothing: a header’s configured limit, a position in the graph.
const UNSUMMED = new Set(["crawl.depth", "graph.depth", "graph.rank"]);

// Whether `path` measures something a total of is meaningful for.
function isSummable(path: string): boolean {
    return !UNSUMMED.has(path) && !path.endsWith(".max-age");
}

// Four decimals, enough for grams of CO2e and fractions of a millisecond.
function rounded(value: number): number {
    return Math.round(value * 10_000) / 10_000;
}

// The middle of an ascending list, the mean of the two middles when even.
export function median(sorted: number[]): number {
    const middle = sorted.length / 2;
    return sorted.length % 2 === 1 ? (sorted[Math.floor(middle)] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

// The nearest-rank `q` quantile of an ascending list.
function quantile(sorted: number[], q: number): number {
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] as number;
}

// Count, min, median, p95, max and total of every numeric page fact, CO2, bytes, requests and timings first.
export function factStats(pages: Facts[]): Record<string, Stat> {
    const values = new Map<string, number[]>();
    for (const page of pages) {
        const leaves = Object.entries(flatten(page));
        for (const [path, value] of leaves)
            if (typeof value === "number" && Number.isFinite(value) && !NOMINAL.has(path))
                values
                    .set(path, values.get(path) ?? [])
                    .get(path)
                    ?.push(value);
    }
    const paths = values.keys().toArray().toSorted(byRank);
    log.debug({ pages: pages.length, facts: paths.length }, "fact statistics computed");
    return Object.fromEntries(
        paths.map((path) => {
            const sorted = (values.get(path) as number[]).toSorted((a, b) => a - b);
            const total = sorted.reduce((sum, value) => sum + value, 0);
            return [path, { count: sorted.length, min: sorted[0] as number, median: rounded(median(sorted)), p95: quantile(sorted, 0.95), max: sorted.at(-1) as number, ...(isSummable(path) && { total: rounded(total) }) }];
        }),
    );
}
