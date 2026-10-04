// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// An ISO time as `2026-10-03 22:05 UTC`.
export function utc(iso: string): string {
    return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

// When a page was read and what answered, as a finding says it.
export function readNote(seen: { at: string; cached?: true; revalidated?: true }): string {
    return `read ${utc(seen.at)}${seen.cached ? ", from the cache" : seen.revalidated ? ", confirmed unchanged" : ""}`;
}
