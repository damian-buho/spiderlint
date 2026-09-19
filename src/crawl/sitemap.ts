// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { discoverValidSitemaps, parseSitemap } from "crawlee";
import type { SitemapFacts } from "../facts/types.ts";
import { log } from "../logger.ts";

export type SitemapIndex = Map<string, SitemapFacts>;

// robots.txt `Sitemap:` lines plus the common `/sitemap.xml` names, unioned into one href → facts index.
export async function loadSitemap(seeds: string[]): Promise<SitemapIndex> {
    const index: SitemapIndex = new Map();
    const files = await Array.fromAsync(discoverValidSitemaps(seeds));
    if (files.length === 0) {
        log.info({ seeds }, "no sitemap discovered");
        return index;
    }
    log.info({ seeds, files }, "sitemap discovered");
    const sources = files.map((url) => ({ type: "url" as const, url }));
    for await (const entry of parseSitemap(sources)) {
        index.set(entry.loc, {
            listed: true,
            ...(entry.lastmod && { lastmod: entry.lastmod.toISOString() }),
            ...(entry.changefreq && { changefreq: entry.changefreq }),
            ...(entry.priority !== undefined && { priority: entry.priority }),
        });
    }
    log.info({ files: files.length, urls: index.size }, "sitemap parsed");
    return index;
}
