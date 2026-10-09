// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { median } from "../report/stats.ts";
import { get } from "./declarative.ts";
import { said } from "./message.ts";
import type { Datum, Finding, Make } from "./types.ts";

// Iglewicz and Hoaglin’s modified z-score scale and cut-off.
const Z_SCALE = 0.6745;
// Their mean absolute deviation fallback when over half the values are equal.
const MEAN_SCALE = 0.797885;
// Pages the dominance test weighs the largest value against.
const NEXT = 10;
const DOCS = "https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm";

interface NumericSettings {
    facts: string[];
    z: number;
    ratio: number;
    "min-pages": number;
}

interface MinoritySettings {
    facts: string[];
    share: number;
    dominant: number;
    "min-pages": number;
}

const NUMERIC: NumericSettings = { facts: ["co2.grams", "http.size.body", "resources.length", "http.timing.total"], z: 3.5, ratio: 3, "min-pages": 20 };
const MINORITY: MinoritySettings = { facts: ["http.version", "http.headers.content-encoding", "http.headers.cache-control"], share: 0.1, dominant: 0.8, "min-pages": 20 };

// Pages carrying a value for `read`, grouped by it in first-seen order.
export function partition(pages: Facts[], read: (page: Facts) => string | undefined): Map<string, Facts[]> {
    return Map.groupBy(
        pages.filter((page) => read(page) !== undefined),
        (page) => read(page) as string,
    );
}

// Pages that answered 2xx, the only ones an insight compares.
function served(pages: Facts[]): Facts[] {
    return pages.filter((page) => page.http.status >= 200 && page.http.status < 300);
}

// A fact as one comparable string, repeated headers joined; objects and arrays are not categories.
function category(page: Facts, path: string): string | undefined {
    const value = get(page, path);
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value.join(", ");
    return ["string", "number", "boolean"].includes(typeof value) ? String(value) : undefined;
}

// The message sentences; each listed page’s own value rides in the finding’s `data`.
const SENTENCES = {
    outlier: "{label} is far above the median {median} of {count} pages",
    dominates: "{label} is far above the median {median} of {count} pages; the first alone outweighs the next {next} pages combined",
    minority: "{label} is {common} on {count} of {total} pages, but not on these",
};

// The pages whose `path` lies far above the rest by modified z-score and by `ratio` times the median.
function outliers(pages: Facts[], path: string, settings: NumericSettings, severity: Finding["severity"]): Finding | undefined {
    const measured = pages.flatMap((page) => {
        const value = get(page, path);
        return typeof value === "number" && Number.isFinite(value) ? [{ url: page.url.href, value }] : [];
    });
    if (measured.length < settings["min-pages"]) return undefined;
    const sorted = measured.map((entry) => entry.value).toSorted((a, b) => a - b);
    const middle = median(sorted);
    const deviations = sorted.map((value) => Math.abs(value - middle));
    const mad = median(deviations.toSorted((a, b) => a - b));
    const scale = mad > 0 ? mad / Z_SCALE : deviations.reduce((sum, value) => sum + value, 0) / deviations.length / MEAN_SCALE;
    const far = scale > 0 ? measured.filter((entry) => (entry.value - middle) / scale > settings.z && entry.value >= middle * settings.ratio).toSorted((a, b) => b.value - a.value) : [];
    log.debug({ rule: "insight/numeric-outlier", fact: path, pages: measured.length, median: middle, mad, scale, outliers: far.length }, "numeric fact compared");
    const [top] = far;
    if (!top) return undefined;
    const next = sorted.slice(-NEXT - 1, -1).reduce((sum, value) => sum + value, 0);
    const isDominant = sorted.length > NEXT && top.value > next;
    const data = Object.fromEntries(far.map((entry) => [entry.url, { value: { fact: path, value: entry.value }, ...(middle > 0 && { ratio: { ratio: entry.value / middle } }) } satisfies Record<string, Datum>]));
    return {
        rule: "insight/numeric-outlier",
        severity,
        scope: "site",
        url: top.url,
        ...said(isDominant ? SENTENCES.dominates : SENTENCES.outlier, { label: { name: path }, median: { fact: path, value: middle }, count: measured.length, ...(isDominant && { next: NEXT }) }),
        data,
        value: { median: middle, ...Object.fromEntries(far.map((entry) => [entry.url, entry.value])) },
        urls: far.map((entry) => entry.url),
    };
}

// The pages holding a rare value of `path` while most pages share one other value.
function minority(pages: Facts[], path: string, settings: MinoritySettings, severity: Finding["severity"]): Finding | undefined {
    const byValue = [...partition(pages, (page) => category(page, path))].toSorted(([, a], [, b]) => b.length - a.length);
    const total = byValue.reduce((sum, [, members]) => sum + members.length, 0);
    const [top, ...rest] = byValue;
    const rare = rest.filter(([, members]) => members.length / total <= settings.share);
    const isDominant = top !== undefined && top[1].length / total >= settings.dominant;
    log.debug({ rule: "insight/minority-value", fact: path, pages: total, values: byValue.length, top: top?.[0], rare: rare.length, isDominant }, "categorical fact compared");
    if (!top || !isDominant || total < settings["min-pages"] || rare.length === 0) return undefined;
    const urls = rare.flatMap(([, members]) => members.map((page) => page.url.href));
    const data = Object.fromEntries(rare.flatMap(([value, members]) => members.map((page) => [page.url.href, { value }])));
    return { rule: "insight/minority-value", severity, scope: "site", url: urls[0] as string, ...said(SENTENCES.minority, { label: { name: path }, common: top[0], count: top[1].length, total }), data, value: Object.fromEntries(byValue.map(([value, members]) => [value, members.length])), urls };
}

// One finding per numeric fact whose pages hold robust outliers above the median.
const numericOutlier: Make = (severity, expect) => {
    const settings = { ...NUMERIC, ...(expect as Partial<NumericSettings>) };
    return {
        meta: { id: "insight/numeric-outlier", severity, scope: "site", facts: settings.facts, docs: DOCS, fix: "Find what makes the listed pages cost more than the rest, an uncached query or an oversized image, and bring them near the median." },
        check: (pages: Facts[]) => settings.facts.map((path) => outliers(served(pages), path, settings, severity)).filter((finding) => finding !== undefined),
    };
};

// One finding per categorical fact where a few pages break the value nearly every page shares.
const minorityValue: Make = (severity, expect) => {
    const settings = { ...MINORITY, ...(expect as Partial<MinoritySettings>) };
    return {
        meta: { id: "insight/minority-value", severity, scope: "site", facts: settings.facts, fix: "Serve the listed pages the way the rest of the site serves them, or keep the difference only where it is deliberate." },
        check: (pages: Facts[]) => settings.facts.map((path) => minority(served(pages), path, settings, severity)).filter((finding) => finding !== undefined),
    };
};

export const insightRules: Record<string, Make> = { "insight/numeric-outlier": numericOutlier, "insight/minority-value": minorityValue };
