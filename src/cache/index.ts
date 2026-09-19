// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export type Bucket = "pages" | "probes" | "resources" | "robots" | "sitemaps" | "extractors";

export interface Cache {
    get(bucket: Bucket, key: string): Promise<string | undefined>;
    set(bucket: Bucket, key: string, value: string, ttlSeconds: number): Promise<void>;
    purge(bucket?: Bucket): Promise<number>;
}

// Bypass cache: every lookup misses.
export class NullCache implements Cache {
    get(): Promise<undefined> {
        return Promise.resolve(undefined);
    }

    set(): Promise<void> {
        return Promise.resolve();
    }

    purge(): Promise<number> {
        return Promise.resolve(0);
    }
}
