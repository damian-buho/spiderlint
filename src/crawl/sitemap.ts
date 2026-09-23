// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { gunzipSync } from "node:zlib";
import { discoverValidSitemaps, parseSitemap, type SitemapUrl } from "crawlee";
import type { SitemapFacts, SitemapFileFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { fetchRetrying, reason } from "./fetch.ts";

export type SitemapIndex = Map<string, SitemapFacts>;

export interface Sitemaps {
    index: SitemapIndex;
    files: SitemapFileFacts[];
}

// sitemaps.org caps one file at 50 MiB uncompressed.
const MAX_BYTES = 50 * 1024 * 1024;
const GZIP = Buffer.from([0x1f, 0x8b]);

type Entry = SitemapUrl | { loc: string; originSitemapUrl: null };

// Body text, gunzipped when the bytes carry the gzip magic.
function decode(body: Buffer): string {
    return (body.subarray(0, 2).equals(GZIP) ? gunzipSync(body, { maxOutputLength: MAX_BYTES }) : body).toString("utf8");
}

// A text/plain or `.txt` file lists one URL per line; anything else parses as XML, nested sitemaps as `originSitemapUrl: null`.
async function* entries(url: string, contentType: string | undefined, content: string): AsyncGenerator<Entry> {
    const isText = contentType === "text/plain" || new URL(url).pathname.replace(/\.gz$/, "").endsWith(".txt");
    if (!isText) return yield* parseSitemap([{ type: "raw", content }], undefined, { maxDepth: 0, emitNestedSitemaps: true });
    for (const line of content.split(/\r?\n/)) {
        const loc = line.trim();
        if (URL.canParse(loc)) yield { loc, originSitemapUrl: url };
    }
}

// Parses one fetched body into `file` counts: page entries land in `index`, same-host nested sitemaps in `queue`.
async function collect(file: SitemapFileFacts, contentType: string | undefined, body: Buffer, index: SitemapIndex, queue: string[]): Promise<void> {
    const found = entries(file.url, contentType, decode(body));
    for await (const entry of found) {
        if (entry.originSitemapUrl === null) {
            file.sitemaps += 1;
            const isSameHost = new URL(entry.loc).hostname === new URL(file.url).hostname;
            log[isSameHost ? "debug" : "info"]({ sitemap: file.url, nested: entry.loc, isSameHost }, "nested sitemap found");
            if (isSameHost) queue.push(entry.loc);
            continue;
        }
        file.urls += 1;
        index.set(entry.loc, {
            listed: true,
            ...(entry.lastmod && { lastmod: entry.lastmod.toISOString() }),
            ...(entry.changefreq && { changefreq: entry.changefreq }),
            ...(entry.priority !== undefined && { priority: entry.priority }),
        });
    }
}

// Fetches and parses one file into its facts; `error` says which step failed.
async function readSitemap(url: string, index: SitemapIndex, queue: string[]): Promise<SitemapFileFacts> {
    const file: SitemapFileFacts = { url, status: 0, urls: 0, sitemaps: 0 };
    try {
        const { response, value } = await fetchRetrying(url, async (response) => Buffer.from(await response.arrayBuffer()));
        file.status = response.status;
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (!response.ok) file.error = `answers ${response.status}`;
        else if (contentType === "text/html") file.error = `is ${contentType}, not a sitemap`;
        else await collect(file, contentType, value, index, queue);
        if (!file.error && file.urls + file.sitemaps === 0) file.error = `names no URL (${contentType ?? "no content-type"})`;
    } catch (error) {
        file.error = `${file.status > 0 ? "does not parse" : "does not fetch"}: ${reason(error).split("\n", 1)[0]}`;
    }
    log[file.error ? "warn" : "debug"](file, "sitemap read");
    return file;
}

// robots.txt `Sitemap:` lines plus the common `/sitemap.xml` names, each file and its nested files read once.
export async function loadSitemap(seeds: string[]): Promise<Sitemaps> {
    const index: SitemapIndex = new Map();
    const queue = await Array.fromAsync(discoverValidSitemaps(seeds));
    log.info({ seeds, files: queue }, queue.length > 0 ? "sitemap discovered" : "no sitemap discovered");
    const seen = new Set<string>();
    const files: SitemapFileFacts[] = [];
    for (const url of queue) {
        if (seen.has(url)) continue;
        seen.add(url);
        files.push(await readSitemap(url, index, queue));
    }
    log.info({ files: files.length, failed: files.filter((file) => file.error).length, urls: index.size }, "sitemap parsed");
    return { index, files };
}
