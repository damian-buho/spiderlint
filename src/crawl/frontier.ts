// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Configuration, Request, RequestQueue, RequestTransform } from "crawlee";
import picomatch from "picomatch";
import type { Config } from "../config/index.ts";
import type { Facts, SitemapFacts, SitemapFileFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RobotsFor } from "./robots.ts";
import { isInScope } from "./scope.ts";
import { loadSitemap, type SitemapBucket, type Sitemaps } from "./sitemap.ts";

export type OnPage = (facts: Facts, body: string) => Promise<void> | void;

// Cached lookups a crawl reads through.
export interface CrawlCache {
    robots: RobotsFor;
    sitemaps: SitemapBucket;
}

// A page as the previous crawl stored it.
export interface Earlier {
    facts: Facts;
    body: string;
}

// Persistent crawl state a store lends the crawler; absent, everything stays in memory.
export interface CrawlStorage {
    config: Configuration;
    requestQueue: RequestQueue;
    earlier?: (href: string) => Promise<Earlier | undefined>;
}

interface Globs {
    include: picomatch.Matcher[];
    exclude: picomatch.Matcher[];
}

function globMatchers(config: Config): Globs {
    return { include: config.include.map((glob) => picomatch(glob)), exclude: config.exclude.map((glob) => picomatch(glob)) };
}

// The one crawler call a frontier drives, whatever the crawler class.
interface Runnable {
    run(requests: string[], options?: { purgeRequestQueue?: boolean }): Promise<unknown>;
}

// What every fetch mode shares: seeds, sitemap, globs, robots, the page budget and the visited set.
export class Frontier {
    static async open(config: Config, cache: CrawlCache): Promise<Frontier> {
        return new Frontier(config, config.sitemap ? await loadSitemap(config.seeds, cache.robots, cache.sitemaps) : { index: new Map(), files: [] });
    }

    readonly #config: Config;
    readonly #seeds: Set<string>;
    readonly #sitemap: Sitemaps["index"];
    readonly #skipped = new Map<string, string>();
    readonly #visited = new Set<string>();
    readonly #globs: Globs;
    // Crawlee resets maxRequestsPerCrawl on every run(), so --max-pages needs its own cross-phase tally.
    #handled = 0;
    readonly files: SitemapFileFacts[];

    // Include and exclude globs run on `pathname + search`, as group matchers do.
    readonly transformRequestFunction: RequestTransform = (request) => {
        const { include, exclude } = this.#globs;
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const reason = include.length > 0 && include.every((match) => !match(path)) ? "include" : exclude.some((match) => match(path)) ? "exclude" : undefined;
        if (!reason) return request;
        log.debug({ url: request.url, reason }, "link skipped");
        this.#skipped.set(request.url, reason);
        return false;
    };

    private constructor(config: Config, sitemaps: Sitemaps) {
        this.#config = config;
        this.#seeds = new Set(config.seeds);
        this.#sitemap = sitemaps.index;
        this.#globs = globMatchers(config);
        this.files = sitemaps.files;
    }

    // A sitemap URL still unvisited once the link crawl settles joins the frontier as its own root.
    #stragglers(): string[] {
        if (this.#sitemap.size === 0 || this.#config.seeds.length === 0) return [];
        const reference = new URL(this.#config.seeds[0] as string);
        const { include, exclude } = this.#globs;
        const extra = this.#sitemap
            .keys()
            .filter((href) => {
                if (this.#visited.has(href)) return false;
                const url = new URL(href);
                if (!isInScope(url, reference, this.#config.scope)) return false;
                const path = url.pathname + url.search;
                return (include.length === 0 || include.some((match) => match(path))) && exclude.every((match) => !match(path));
            })
            .toArray();
        log.debug({ listed: this.#sitemap.size, unvisited: extra.length }, "sitemap stragglers");
        return extra;
    }

    // Crawler options every adapter passes through unchanged.
    options(storage?: CrawlStorage): { requestQueue?: RequestQueue; maxRequestsPerCrawl?: number; maxCrawlDepth?: number; respectRobotsTxtFile: false | { userAgent: string }; onSkippedRequest: (skip: { url: string; reason: string }) => void } {
        return {
            ...(storage && { requestQueue: storage.requestQueue }),
            maxRequestsPerCrawl: this.#config.maxPages || undefined,
            maxCrawlDepth: this.#config.maxDepth || undefined,
            respectRobotsTxtFile: this.#config.robots && { userAgent: "spiderlint" },
            onSkippedRequest: ({ url, reason }) => {
                log.debug({ url, reason }, "link skipped");
                this.#skipped.set(url, reason);
            },
        };
    }

    // False once --max-pages is spent; otherwise the requested and the loaded URL count as visited.
    admit(request: Request, loaded: URL): boolean {
        this.#handled += 1;
        if (this.#config.maxPages && this.#handled > this.#config.maxPages) {
            log.debug({ url: request.url, handled: this.#handled, maxPages: this.#config.maxPages }, "page dropped past max-pages");
            return false;
        }
        this.#visited.add(request.url);
        this.#visited.add(loaded.href);
        return true;
    }

    // The facts a page owes to its URL and how the crawl reached it, whatever fetched it.
    identity(request: Request, url: URL): Pick<Facts, "url" | "group" | "crawl" | "sitemap"> {
        const listing: SitemapFacts | undefined = this.#sitemap.get(request.url);
        return {
            url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
            group: "default",
            crawl: { depth: request.crawlDepth, discoveredVia: request.crawlDepth > 0 ? "link" : this.#seeds.has(request.url) ? "seed" : "sitemap", referrers: [], ...(request.url !== url.href && { requested: request.url }) },
            ...(this.#sitemap.size > 0 && { sitemap: listing ?? { listed: false } }),
        };
    }

    // Seeds first, sitemap stragglers while the budget lasts; robots.txt answered through the robots bucket.
    async run(crawler: Runnable, robots: RobotsFor): Promise<void> {
        const answer = (url: string) => (this.#config.robots ? robots(url) : Promise.resolve(undefined));
        Object.assign(crawler, { getRobotsTxtFileForUrl: answer });
        await crawler.run(this.#config.seeds);
        const stragglers = this.#stragglers();
        const isOverBudget = this.#config.maxPages > 0 && this.#handled >= this.#config.maxPages;
        if (!isOverBudget && stragglers.length > 0) await crawler.run(stragglers, { purgeRequestQueue: false });
        const reasons = Object.groupBy(this.#skipped.values(), (reason) => reason);
        if (this.#skipped.size > 0) log.info({ skipped: this.#skipped.size, ...Object.fromEntries(Object.entries(reasons).map(([reason, all]) => [reason, all?.length])) }, "links skipped");
    }
}
