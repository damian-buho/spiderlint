// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export type Scalar = string | number | boolean;

// A key naming a URL or path, as `html.links.rel` does per href; such a map is left out.
const URL_KEY = /^(?:[a-z][\w+.-]*:)?\//i;

// Path prefixes in reading order: CO2, bytes, requests, timings; the rest follow by path.
const RANK = [/^co2\./, /^http\.size\./, /^browser\.weight\./, /^resources\.length$/, /^http\.timing\./, /^browser\.timing\./];

// Scalar leaves of a facts document by dotted path; an array becomes its `.length`, a URL-keyed map is left out.
export function flatten(value: unknown, prefix = "", out: Record<string, Scalar> = {}): Record<string, Scalar> {
    if (Array.isArray(value)) out[`${prefix}length`] = value.length;
    else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) if (!URL_KEY.test(key)) flatten(child, `${prefix}${key}.`, out);
    } else if (["string", "number", "boolean"].includes(typeof value)) out[prefix.slice(0, -1)] = value as Scalar;
    return out;
}

// A path’s place in RANK, past its end when unranked.
function rank(path: string): number {
    const index = RANK.findIndex((pattern) => pattern.test(path));
    return index === -1 ? RANK.length : index;
}

// Whether a path is one RANK lists: CO2, bytes, requests or timings.
export function isRanked(path: string): boolean {
    return rank(path) < RANK.length;
}

// Ranked paths first, in RANK order, then the rest by path.
export function byRank(a: string, b: string): number {
    return rank(a) - rank(b) || a.localeCompare(b);
}
