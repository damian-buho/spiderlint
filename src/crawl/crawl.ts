// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Config } from "../config/index.ts";
import { log } from "../logger.ts";
import { browserCrawler } from "./browser.ts";
import { Frontier, type CrawlCache, type CrawlResult, type CrawlStorage, type OnPage, type Runnable } from "./frontier.ts";
import { httpCrawler } from "./http.ts";
import { bridgeCrawleeLog } from "./log.ts";
import type { CrawlerMode, Router } from "./route.ts";

// Crawls with every crawler some group needs, side by side over one frontier that routes each URL to its group’s.
export async function crawlSite(config: Config, onPage: OnPage, cache: CrawlCache, router: Router, storage?: CrawlStorage, proxy?: string, isKeptType?: (contentType: string) => boolean, isDebugged?: boolean, isExpensive?: boolean): Promise<CrawlResult> {
    bridgeCrawleeLog();
    const frontier = await Frontier.open(config, cache, router);
    const modes = router.crawlers;
    const http = modes.includes("http") ? httpCrawler(config, onPage, frontier, storage, proxy) : undefined;
    const browser = modes.includes("browser") ? browserCrawler(config, onPage, frontier, router, storage, proxy, isKeptType, isDebugged, isExpensive) : undefined;
    log.info({ crawlers: modes, groups: router.modes }, "crawlers chosen");
    const crawlers: Partial<Record<CrawlerMode, Runnable>> = { ...(http && { http: http.crawler }), ...(browser && { browser: browser.crawler }) };
    await frontier.run(crawlers, cache.robots);
    const [fetched, rendered] = [http?.stats(), browser?.stats()];
    if (fetched?.revalidated) log.info({ revalidated: fetched.revalidated }, "pages revalidated");
    return {
        site: frontier.site(),
        pages: { ...(fetched && { http: fetched.pages }), ...(rendered && { browser: rendered.pages }) },
        revalidated: fetched?.revalidated ?? 0,
        launches: rendered?.launches ?? 0,
        responses: rendered?.responses ?? new Map(),
        tlsProbes: rendered?.tlsProbes ?? 0,
        modes: router.modes,
    };
}
