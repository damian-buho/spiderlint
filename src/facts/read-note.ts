// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Evidence } from "../rules/types.ts";

// An ISO time as `2026-10-03 22:05 UTC`.
export function utc(iso: string): string {
    return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

// What a rule read from `bucket` under `key`, when, and whether the cache or the origin answered.
export function evidence(bucket: string, key: string, seen: { at?: string; cached?: true; revalidated?: true }, mode?: Evidence["mode"]): Evidence {
    return { bucket, key, ...(seen.at && { at: seen.at }), via: seen.cached ? "cache" : seen.revalidated ? "revalidated" : "network", ...(mode && { mode }) };
}
