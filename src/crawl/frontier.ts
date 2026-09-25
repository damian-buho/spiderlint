// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { ProxyConfiguration, type Configuration, type EnqueueLinksOptions, type Request, type RequestQueue, type RequestTransform } from "crawlee";
import picomatch from "picomatch";
import type { Page } from "playwright";
import type { Config } from "../config/index.ts";
import type { Facts, RobotsFileFacts, SiteFacts, SitemapFacts, SitemapFileFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { crawlDelayOf, robotsFactsOf, type RobotsFor } from "./robots.ts";
import { isInScope, STRATEGY } from "./scope.ts";
import { loadSitemap, type SitemapBucket, type Sitemaps } from "./sitemap.ts";

// Feed media types a head `rel=alternate` names; such a feed is crawled as a page.
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);

type EnqueueLinks = (options: EnqueueLinksOptions) => Promise<{ processedRequests: { wasAlreadyPresent: boolean }[] }>;

export type OnPage = (facts: Facts, body: string, live?: Page) => Promise<void> | void;

// What a crawl found about the site, and how many browsers it launched.
export interface CrawlResult {
    site: SiteFacts;
    launches: number;
}

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
    run(requests: string[]): Promise<unknown>;
    addRequests(requests: string[]): Promise<unknown>;
    getRequestQueue(): Promise<{ isFinished(): Promise<boolean> }>;
}

// What every fetch mode shares: seeds, sitemap, globs, robots, the page budget and the visited set.
export class Frontier {
    static async open(config: Config, cache: CrawlCache): Promise<Frontier> {
        return new Frontier(config, config.sitemap ? await loadSitemap(config.seeds, cache.robots, cache.sitemaps, config.canonicalOrigin) : { index: new Map(), files: [] });
    }

    readonly #config: Config;
    readonly #seeds: Set<string>;
    readonly #sitemap: Sitemaps["index"];
    readonly #skipped = new Map<string, string>();
    readonly #visited = new Set<string>();
    readonly #globs: Globs;
    #robots: RobotsFileFacts[] = [];
    // Crawlee resets maxRequestsPerCrawl on every run(), so --max-pages needs its own cross-phase tally.
    #handled = 0;
    #crawler?: Runnable;
    #hasStraggled = false;
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

    // Finished once the queue drains and no sitemap straggler is left to add.
    async #isFinished(): Promise<boolean> {
        const crawler = this.#crawler as Runnable;
        const queue = await crawler.getRequestQueue();
        if (!(await queue.isFinished())) return false;
        if (this.#hasStraggled) return true;
        this.#hasStraggled = true;
        const stragglers = this.#stragglers();
        const isOverBudget = this.#config.maxPages > 0 && this.#handled >= this.#config.maxPages;
        log.debug({ stragglers: stragglers.length, handled: this.#handled, isOverBudget }, "queue drained");
        if (isOverBudget || stragglers.length === 0) return true;
        await crawler.addRequests(stragglers);
        return false;
    }

    // Each seed’s origin, once.
    #origins(): string[] {
        return [...new Set(this.#config.seeds.map((seed) => new URL(seed).origin))];
    }

    // The longest `Crawl-delay` over the seed origins, as Crawlee applies one delay to every domain.
    async #crawlDelay(robots: RobotsFor): Promise<number> {
        const origins = this.#origins();
        const delays = await Promise.all(origins.map(async (origin) => crawlDelayOf(await robots(origin))));
        const delay = Math.max(0, ...delays);
        if (delay > 0) log.info({ delay, origins: origins.length }, "robots.txt crawl-delay honoured, seconds between requests per domain");
        return delay;
    }

    // Crawler options every adapter passes through unchanged.
    options(storage?: CrawlStorage, proxy?: string): { requestQueue?: RequestQueue; autoscaledPoolOptions: { isFinishedFunction: () => Promise<boolean> }; sessionPoolOptions: { blockedStatusCodes: number[] }; maxRequestsPerCrawl?: number; maxRequestsPerMinute?: number; maxCrawlDepth?: number; proxyConfiguration?: ProxyConfiguration; respectRobotsTxtFile: false | { userAgent: string }; onSkippedRequest: (skip: { url: string; reason: string }) => void } {
        return {
            ...(storage && { requestQueue: storage.requestQueue }),
            autoscaledPoolOptions: { isFinishedFunction: () => this.#isFinished() },
            // A 401, 403 or 429 is a page to lint, never a session to retire and retry.
            sessionPoolOptions: { blockedStatusCodes: [] },
            maxRequestsPerCrawl: this.#config.maxPages || undefined,
            maxRequestsPerMinute: this.#config.rate || undefined,
            ...(proxy && { proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxy] }) }),
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

    // The facts a page owes to its URL and how the crawl reached it, whatever fetched it; the sitemap entry is the loaded URL’s, else the requested one’s.
    identity(request: Request, url: URL): Pick<Facts, "url" | "group" | "crawl" | "sitemap"> {
        const listing: SitemapFacts | undefined = this.#sitemap.get(url.href) ?? this.#sitemap.get(request.url);
        return {
            url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
            group: "default",
            crawl: { depth: request.crawlDepth, discoveredVia: request.crawlDepth > 0 ? "link" : this.#seeds.has(request.url) ? "seed" : "sitemap", referrers: [], ...(request.url !== url.href && { requested: request.url }) },
            ...(this.#sitemap.size > 0 && { sitemap: listing ?? { listed: false } }),
        };
    }

    // The page’s anchors, then its head feeds, queued under the scope and globs; returns how many were new.
    async enqueue(enqueueLinks: EnqueueLinks, facts: Facts): Promise<number> {
        const options = { strategy: STRATEGY[this.#config.scope], transformRequestFunction: this.transformRequestFunction };
        const heads = facts.html?.head.links ?? [];
        const feeds = heads.filter((link) => /\balternate\b/i.test(link.rel ?? "") && FEED_TYPES.has(link.type?.toLowerCase() ?? "")).flatMap((link) => (link.href ? [link.href] : []));
        log.debug({ url: facts.url.href, feeds }, "head feeds found");
        const batches = [await enqueueLinks(options), ...(feeds.length > 0 ? [await enqueueLinks({ ...options, urls: feeds })] : [])];
        return batches.flatMap((batch) => batch.processedRequests).filter((entry) => !entry.wasAlreadyPresent).length;
    }

    // What the crawl learnt about the site: sitemap files, and each seed origin’s robots.txt when one was read.
    site(): SiteFacts {
        return { sitemaps: this.files, ...(this.#robots.length > 0 && { robots: this.#robots }) };
    }

    // Seeds first, sitemap stragglers while the budget lasts; robots.txt answered through the robots bucket.
    async run(crawler: Runnable, robots: RobotsFor): Promise<void> {
        const answer = (url: string) => (this.#config.robots ? robots(url) : Promise.resolve(undefined));
        Object.assign(crawler, { getRobotsTxtFileForUrl: answer });
        const delay = this.#config.robots ? await this.#crawlDelay(robots) : 0;
        if (delay > 0) Object.assign(crawler, { sameDomainDelayMillis: delay * 1000 });
        this.#crawler = crawler;
        await crawler.run(this.#config.seeds);
        const isRead = this.#config.robots || this.#config.sitemap;
        const files = isRead ? await Promise.all(this.#origins().map(async (origin) => robotsFactsOf(await robots(origin)))) : [];
        this.#robots = files.filter((facts) => facts !== undefined);
        log.debug({ isRead, files: this.#robots.length }, "robots.txt facts collected");
        const reasons = Object.groupBy(this.#skipped.values(), (reason) => reason);
        if (this.#skipped.size > 0) log.info({ skipped: this.#skipped.size, ...Object.fromEntries(Object.entries(reasons).map(([reason, all]) => [reason, all?.length])) }, "links skipped");
    }
}
