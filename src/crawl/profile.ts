// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { fetchCached, type Stored } from "../cache/http.ts";
import type { Bucket } from "../cache/index.ts";
import { log } from "../logger.ts";
import { RobotsDisallowed } from "./probe.ts";
import type { RobotsFor } from "./robots.ts";

// Bytes of a page read, as a probe reads at most as many.
const MAX_BODY = 1_048_576;

type Page = { url: string; body: string };

export type ProfileBucket = Bucket<Stored<Page>>;

// A page another host serves, as the origin last said it.
export interface Cached {
    url: string;
    status: number;
    body: string;
    // When the origin last confirmed it: fetched now, revalidated now, or stored earlier.
    at: string;
    cached?: true;
    revalidated?: true;
}

async function read(response: Response): Promise<Page> {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const stream = response.body;
    if (stream) {
        for await (const chunk of stream) {
            chunks.push(chunk);
            bytes += chunk.byteLength;
            if (bytes >= MAX_BODY) break;
        }
    }
    return { url: response.url, body: Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8") };
}

// A GET answered from `bucket` while fresh, revalidated with its validators once stale; robots.txt applies as to any probe.
export async function cachedGet(url: string, bucket: ProfileBucket, robots: RobotsFor | undefined): Promise<Cached> {
    const file = await robots?.(url);
    if (file && !file.isAllowed(url, "spiderlint")) {
        log.info({ url }, "robots.txt disallows the page; skipped");
        throw new RobotsDisallowed(`robots.txt disallows ${url}`);
    }
    const { status, value, at, cached, revalidated } = await fetchCached(bucket, url, read, true);
    log.debug({ url, status, at, cached, revalidated }, "page read through the profiles bucket");
    return { url: value.url, status, body: value.body, at: at ?? new Date().toISOString(), ...(cached && { cached }), ...(revalidated && { revalidated }) };
}
