// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { gunzipSync } from "node:zlib";
import { load } from "cheerio";
import { parseSitemap, type SitemapUrl } from "crawlee";
import { fetchCached, type Stored } from "../cache/http.ts";
import { OfflineMiss, type Bucket } from "../cache/index.ts";
import type { Facts, SitemapFacts, SitemapFileFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";
import type { RobotsFor } from "./robots.ts";
import { onOrigin } from "./scope.ts";

export type SitemapIndex = Map<string, SitemapFacts>;

export type SitemapBucket = Bucket<Stored<string>>;

export interface Sitemaps {
    index: SitemapIndex;
    files: SitemapFileFacts[];
}

// sitemaps.org caps one file at 50 MiB uncompressed.
const MAX_BYTES = 50 * 1024 * 1024;
const GZIP = Buffer.from([0x1f, 0x8b]);

// Probed when no seed names a sitemap itself, as Crawlee’s discovery does.
const CANDIDATES = ["/sitemap.xml", "/sitemap.txt", "/sitemap_index.xml"];
const SITEMAP_NAME = /sitemap(?:_index)?\.(?:xml|txt)(?:\.gz)?$/i;

// The body as base64, so gzip bytes survive the JSON bucket.
async function base64(response: Response): Promise<string> {
    return Buffer.from(await response.arrayBuffer()).toString("base64");
}

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

// The image and video files a page’s sitemap entry lists.
export function mediaOf(page: Facts): string[] {
    return [...(page.sitemap?.images ?? []), ...(page.sitemap?.videos ?? [])];
}

type Extension = Pick<SitemapFacts, "alternates" | "images" | "videos">;

// Alternates, images and videos per `<loc>`, parsed only when the file declares one of those namespaces.
function extensions(content: string): Map<string, Extension> {
    const found = new Map<string, Extension>();
    if (!/<(?:xhtml|image|video):/.test(content)) return found;
    const $ = load(content, { xml: true });
    const texts = (selection: ReturnType<typeof $>) => selection.map((_, element) => $(element).text().trim()).get().filter((text) => text.length > 0);
    for (const element of $("url")) {
        const url = $(element);
        const alternates = url.children(String.raw`xhtml\:link[rel='alternate'][hreflang][href]`).map((_, link) => ({ lang: String($(link).attr("hreflang")), href: String($(link).attr("href")) })).get();
        const images = texts(url.find(String.raw`image\:image > image\:loc`));
        const videos = texts(url.find(String.raw`video\:video > video\:content_loc, video\:video > video\:player_loc`));
        found.set(url.children("loc").text().trim(), { ...(alternates.length > 0 && { alternates }), ...(images.length > 0 && { images }), ...(videos.length > 0 && { videos }) });
    }
    log.debug({ entries: found.size }, "sitemap extensions parsed");
    return found;
}

// Parses one fetched body into `file` counts: page entries land in `index`, same-host nested sitemaps in `queue`; `canonical` URLs move onto the file’s origin.
async function collect(file: SitemapFileFacts, contentType: string | undefined, body: Buffer, index: SitemapIndex, queue: string[], canonical?: string): Promise<void> {
    const content = decode(body);
    const extended = extensions(content);
    const origin = new URL(file.url).origin;
    const found = entries(file.url, contentType, content);
    for await (const listed of found) {
        const entry = { ...listed, loc: onOrigin(listed.loc, canonical, origin) };
        if (entry.originSitemapUrl === null) {
            file.sitemaps += 1;
            const isSameHost = new URL(entry.loc).hostname === new URL(file.url).hostname;
            log[isSameHost ? "debug" : "info"]({ sitemap: file.url, nested: entry.loc, isSameHost }, "nested sitemap found");
            if (isSameHost) queue.push(entry.loc);
            continue;
        }
        file.urls += 1;
        const { alternates, images, videos } = extended.get(listed.loc) ?? {};
        index.set(entry.loc, {
            listed: true,
            ...(entry.lastmod && { lastmod: entry.lastmod.toISOString() }),
            ...(entry.changefreq && { changefreq: entry.changefreq }),
            ...(entry.priority !== undefined && { priority: entry.priority }),
            ...(alternates && { alternates }),
            ...(images && { images: images.map((href) => onOrigin(href, canonical, origin)) }),
            ...(videos && { videos: videos.map((href) => onOrigin(href, canonical, origin)) }),
        });
    }
}

// Fetches and parses one file into its facts; `error` says which step failed.
async function readSitemap(url: string, index: SitemapIndex, queue: string[], bucket: SitemapBucket, canonical?: string): Promise<SitemapFileFacts> {
    const file: SitemapFileFacts = { url, status: 0, urls: 0, sitemaps: 0 };
    try {
        const { status, headers, value } = await fetchCached(bucket, url, base64);
        file.status = status;
        const contentType = String(headers["content-type"] ?? "").split(";", 1)[0]?.trim() || undefined;
        if (status < 200 || status >= 300) file.error = `answers ${status}`;
        else if (contentType === "text/html") file.error = `is ${contentType}, not a sitemap`;
        else await collect(file, contentType, Buffer.from(value, "base64"), index, queue, canonical);
        if (!file.error && file.urls + file.sitemaps === 0) file.error = `names no URL (${contentType ?? "no content-type"})`;
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        file.error = `${file.status > 0 ? "does not parse" : "does not fetch"}: ${reason(error).split("\n", 1)[0]}`;
    }
    log[file.error ? "warn" : "debug"](file, "sitemap read");
    return file;
}

// A candidate name counts when it answers 2xx; its body stays in `bucket` for the read that follows.
async function isAnswering(url: string, bucket: SitemapBucket): Promise<boolean> {
    try {
        const { status } = await fetchCached(bucket, url, base64);
        log.debug({ url, status }, "sitemap candidate probed");
        return status >= 200 && status < 300;
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        log.debug({ url, error: reason(error) }, "sitemap candidate unreachable");
        return false;
    }
}

// Per origin: its robots.txt `Sitemap:` lines, `canonical` ones read from this origin, then the seeds naming a sitemap, else the common names that answer.
async function discover(seeds: string[], robotsFor: RobotsFor, bucket: SitemapBucket, canonical?: string): Promise<string[]> {
    const found = new Set<string>();
    const origins = new Set(seeds.map((seed) => new URL(seed).origin));
    for (const origin of origins) {
        const robots = await robotsFor(origin);
        const listed = robots.getSitemaps({ enqueueStrategy: "all" }).map((url) => onOrigin(url, canonical, origin));
        for (const url of listed) found.add(url);
        const named = seeds.filter((seed) => new URL(seed).origin === origin && SITEMAP_NAME.test(seed));
        const candidates = named.length > 0 ? [] : CANDIDATES.map((pathname) => new URL(pathname, origin).href);
        for (const url of named) found.add(url);
        for (const url of candidates) if (await isAnswering(url, bucket)) found.add(url);
        log.debug({ origin, canonical, listed, found: found.size, named: named.length, probed: candidates.length }, "sitemaps discovered for origin");
    }
    return [...found];
}

// robots.txt `Sitemap:` lines plus the common `/sitemap.xml` names, each file and its nested files read once.
export async function loadSitemap(seeds: string[], robotsFor: RobotsFor, bucket: SitemapBucket, canonical?: string): Promise<Sitemaps> {
    const index: SitemapIndex = new Map();
    const queue = await discover(seeds, robotsFor, bucket, canonical);
    log.info({ seeds, files: queue }, queue.length > 0 ? "sitemap discovered" : "no sitemap discovered");
    const seen = new Set<string>();
    const files: SitemapFileFacts[] = [];
    for (const url of queue) {
        if (seen.has(url)) continue;
        seen.add(url);
        files.push(await readSitemap(url, index, queue, bucket, canonical));
    }
    log.info({ files: files.length, failed: files.filter((file) => file.error).length, urls: index.size }, "sitemap parsed");
    return { index, files };
}
