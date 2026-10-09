// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { ConfigError, type Config } from "../config/index.ts";
import type { CrawlEnd } from "../facts/types.ts";
import { interrupted } from "../interrupt.ts";
import { log } from "../logger.ts";
import { browserCrawler } from "./browser.ts";
import { Frontier, type CrawlCache, type CrawlResult, type CrawlStorage, type OnPage, type Runnable } from "./frontier.ts";
import { httpCrawler } from "./http.ts";
import { bridgeCrawleeLog } from "./log.ts";
import type { CrawlerMode, Router } from "./route.ts";
import { singleOrigin } from "./scope.ts";
import { trackProgress } from "../progress.ts";

// Crawls with every crawler some group needs, side by side over one frontier that routes each URL to its group’s.
export async function crawlSite(config: Config, onPage: OnPage, cache: CrawlCache, router: Router, storage?: CrawlStorage, proxy?: string, isKeptType?: (contentType: string) => boolean, isDebugged?: boolean, isExpensive?: boolean): Promise<CrawlResult> {
    bridgeCrawleeLog();
    const modes = router.crawlers;
    if (modes.includes("browser") && !config.allowPrivate) throw new ConfigError("fetch browser: the address guard cannot check what the browser connects to");
    const frontier = await Frontier.open(config, cache, router);
    const http = modes.includes("http") ? httpCrawler(config, onPage, frontier, storage, proxy) : undefined;
    const browser = modes.includes("browser") ? await browserCrawler(config, onPage, frontier, router, storage, proxy, isKeptType, isDebugged, isExpensive) : undefined;
    log.debug({ crawlers: modes, groups: router.modes }, "crawlers chosen");
    const crawlers: Partial<Record<CrawlerMode, Runnable>> = { ...(http && { http: http.crawler }), ...(browser && { browser: browser.crawler }) };
    const stop = trackProgress(() => frontier.known(), singleOrigin(config.seeds));
    const halt = (reason: CrawlEnd, why: string) => {
        frontier.cut(reason);
        for (const crawler of [http?.crawler, browser?.crawler]) crawler?.stop(why);
    };
    const interrupt = () => halt("interrupted", `interrupted by ${String(interrupted.reason)}`);
    interrupted.addEventListener("abort", interrupt, { once: true });
    const deadline =
        config.crawlDeadline > 0
            ? setTimeout(() => {
                  log.warn({ crawlDeadline: config.crawlDeadline }, "crawl deadline reached, stopping after the pages in flight");
                  halt("timeout", `crawl deadline of ${config.crawlDeadline} s reached`);
              }, config.crawlDeadline * 1000)
            : undefined;
    try {
        await frontier.run(crawlers, cache.robots, storage?.resumed);
    } finally {
        clearTimeout(deadline);
        interrupted.removeEventListener("abort", interrupt);
        stop();
    }
    const [fetched, rendered] = [http?.stats(), browser?.stats()];
    if (fetched?.revalidated) log.debug({ revalidated: fetched.revalidated }, "pages revalidated");
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
