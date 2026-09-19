// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export type FetchMode = "auto" | "http" | "browser" | "adaptive";

export interface Config {
    seeds: string[];
    fetch: FetchMode;
    maxPages: number;
    robots: boolean;
}

// Skeleton defaults; the org.spiderlint subtree via pf-cli replaces this.
export function defaults(): Config {
    return { seeds: [], fetch: "http", maxPages: 1, robots: true };
}
