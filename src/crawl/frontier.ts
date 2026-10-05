// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { ProxyConfiguration, type Configuration, type EnqueueLinksOptions, type Request, type RequestQueue, type RequestTransform } from "crawlee";
import picomatch from "picomatch";
import type { Page } from "playwright";
import type { Config } from "../config/index.ts";
import type { CrawlEnd, Facts, RobotsFileFacts, SiteFacts, SitemapFacts, SitemapFileFacts } from "../facts/types.ts";
import { vendorPath, type VendorPath } from "../facts/vendors.ts";
import { log } from "../logger.ts";
import { Spread } from "./diversity.ts";
import { width } from "./resources.ts";
import { crawlDelayOf, robotsFactsOf, type RobotsFor } from "./robots.ts";
import type { CrawlerMode, GroupMode, Router } from "./route.ts";
import { isInScope, STRATEGY } from "./scope.ts";
import { loadSitemap, type SitemapBucket, type Sitemaps } from "./sitemap.ts";

// Feed media types a head `rel=alternate` names; such a feed is crawled as a page.
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);

// Item links, the stylesheet and the archive pages a feed names, which its rules judge against the crawl.
function feedTargets(facts: Facts): string[] {
    const feed = facts.feed as { entries?: { link?: string }[]; stylesheet?: string; archives?: Record<string, string> } | undefined;
    return [...(feed?.entries ?? []).flatMap((entry) => (entry.link ? [entry.link] : [])), ...(feed?.stylesheet ? [feed.stylesheet] : []), ...Object.values(feed?.archives ?? {})];
}

type EnqueueLinks = (options: EnqueueLinksOptions) => Promise<{ processedRequests: { wasAlreadyPresent: boolean }[] }>;

export type OnPage = (facts: Facts, body: string, live?: Page) => Promise<void> | void;

// What a crawl found about the site, the pages each crawler handled, and how many browsers it launched.
export interface CrawlResult {
    site: SiteFacts;
    pages: Partial<Record<CrawlerMode, number>>;
    revalidated: number;
    launches: number;
    // Sub-resource responses the browser received, by the URL the page asked for.
    responses: Map<string, Logged>;
    // Handshakes a browser crawl sent for the TLS facts Chromium does not report.
    tlsProbes: number;
    // Each group’s fetch mode, an adaptive one as it settled.
    modes: Record<string, GroupMode>;
}

// One response from the browser’s network log; `body` only where a resource extractor reads its type.
export interface Logged {
    status: number;
    headers: Record<string, string>;
    bytes: number;
    body?: Uint8Array;
    // sha256 of the whole body, read or not.
    digest?: string;
    ms?: number;
}

// Reasons a crawl ended early, the one that names it first.
const CRAWL_ENDS: CrawlEnd[] = ["interrupted", "timeout", "max-pages", "max-depth"];

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
    queues: Record<CrawlerMode, RequestQueue>;
    earlier?: (href: string) => Promise<Earlier | undefined>;
    // Pages an interrupted crawl stored; their links refill the pool of a resumed budget.
    resumed?: Facts[];
}

interface Globs {
    include: picomatch.Matcher[];
    exclude: picomatch.Matcher[];
}

function globMatchers(config: Config): Globs {
    return { include: config.includeUrls.map((glob) => picomatch(glob)), exclude: config.excludeUrls.map((glob) => picomatch(glob)) };
}

// The crawler calls a frontier drives, whatever the crawler class.
export interface Runnable {
    run(requests: string[]): Promise<unknown>;
    addRequests(requests: (string | { url: string; crawlDepth: number })[]): Promise<unknown>;
    getRequestQueue(): Promise<{ isFinished(): Promise<boolean>; getTotalCount(): number }>;
}

// What every fetch mode shares: seeds, sitemap, globs, robots, the page budget, the visited set, and which crawler each URL goes to.
export class Frontier {
    static async open(config: Config, cache: CrawlCache, router: Router): Promise<Frontier> {
        return new Frontier(config, config.sitemap ? await loadSitemap(config.seeds, cache.robots, cache.sitemaps, config.canonicalOrigin) : { index: new Map(), files: [] }, router);
    }

    readonly #config: Config;
    readonly #seeds: Set<string>;
    readonly #sitemap: Sitemaps["index"];
    readonly #skipped = new Map<string, string>();
    // Vendor entries that kept a page out of the crawl, with the pages and the links they took.
    readonly #vendors = new Map<VendorPath, { pages: Set<string>; links: number }>();
    readonly #visited = new Set<string>();
    readonly #globs: Globs;
    #robots: RobotsFileFacts[] = [];
    // Crawlee resets maxRequestsPerCrawl on every run(), so --max-pages needs its own cross-phase tally.
    #handled = 0;
    // Candidates pooled while `diversify` holds, and the requests already given to a crawler.
    readonly #spread: Spread | undefined;
    #released = 0;
    readonly #router: Router;
    readonly #crawlers = new Map<CrawlerMode, Runnable>();
    #hasStraggled = false;
    // Why pages were left unfetched, most telling first.
    readonly #cuts = new Set<CrawlEnd>();
    readonly files: SitemapFileFacts[];

    // A vendor-owned path is no page of the site; include and exclude globs then run on `pathname + search`, as group matchers do.
    readonly transformRequestFunction: RequestTransform = (request) => {
        const vendor = this.#vendorOf(request.url);
        if (vendor) {
            const tally = this.#vendors.get(vendor) ?? { pages: new Set<string>(), links: 0 };
            tally.pages.add(request.url);
            tally.links += 1;
            this.#vendors.set(vendor, tally);
            log.debug({ url: request.url, vendor: vendor.vendor, match: vendor.match }, "link skipped, vendor path");
            return false;
        }
        const { include, exclude } = this.#globs;
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const reason = include.length > 0 && include.every((match) => !match(path)) ? "include" : exclude.some((match) => match(path)) ? "exclude" : undefined;
        if (!reason) return request;
        log.debug({ url: request.url, reason }, "link skipped");
        this.#skipped.set(request.url, reason);
        return false;
    };

    private constructor(config: Config, sitemaps: Sitemaps, router: Router) {
        this.#config = config;
        this.#router = router;
        this.#seeds = new Set(config.seeds);
        this.#sitemap = sitemaps.index;
        this.#globs = globMatchers(config);
        this.#spread = config.diversify ? new Spread(config.maxPages || Infinity) : undefined;
        this.files = sitemaps.files;
    }

    // The shipped vendor entry owning `href` as a page, unless `vendor-paths` is off.
    #vendorOf(href: string): VendorPath | undefined {
        return this.#config.vendorPaths ? vendorPath(href, "page") : undefined;
    }

    // Whether a URL a sitemap or a stored page names may join the crawl: unvisited, no vendor page, in scope and inside the globs.
    #isCrawlable(href: string, reference: URL): boolean {
        if (this.#visited.has(href) || this.#vendorOf(href)) return false;
        const url = new URL(href);
        if (!isInScope(url, reference, this.#config.scope)) return false;
        const { include, exclude } = this.#globs;
        const path = url.pathname + url.search;
        return (include.length === 0 || include.some((match) => match(path))) && exclude.every((match) => !match(path));
    }

    // A sitemap URL still unvisited once the link crawl settles joins the frontier as its own root.
    #stragglers(): string[] {
        if (this.#sitemap.size === 0 || this.#config.seeds.length === 0 || !this.#config.follow) return [];
        const reference = new URL(this.#config.seeds[0] as string);
        const extra = this.#sitemap
            .keys()
            .filter((href) => this.#isCrawlable(href, reference))
            .toArray();
        return extra;
    }

    // Gives the requests to their crawlers, or pools them while a budget spreads; returns how many the pool took.
    async #offer(urls: string[], crawlDepth: number): Promise<number> {
        if (!this.#spread) {
            await this.#add(urls.map((url) => ({ url, crawlDepth })));
            return 0;
        }
        const spread = this.#spread;
        const isDeep = this.#config.maxDepth > 0 && crawlDepth > this.#config.maxDepth;
        let pooled = 0;
        for (const url of urls) {
            if (this.#visited.has(url)) continue;
            const isNew = spread.add({ url, crawlDepth });
            const isRelinked = !isNew && !isDeep && spread.relink(url, crawlDepth);
            if (isNew) pooled += 1;
            if (isRelinked) log.debug({ url, crawlDepth }, "listed candidate reached by a link");
        }
        log.debug({ offered: urls.length, pooled, size: this.#spread.size, crawlDepth }, "candidates pooled");
        await this.#refill();
        return pooled;
    }

    // Counts the seeds and the pages a resumed crawl stored as scheduled, then pools their links and the sitemap, which a spread crawl draws from at once.
    #prime(resumed: Facts[]): void {
        const spread = this.#spread as Spread;
        for (const page of resumed) {
            this.#visited.add(page.url.href);
            if (page.crawl.requested) this.#visited.add(page.crawl.requested);
            if (spread.note(page.url.href)) this.#released += 1;
        }
        this.#handled += resumed.length;
        for (const seed of this.#seeds) if (spread.note(seed)) this.#released += 1;
        const reference = this.#config.seeds[0] ? new URL(this.#config.seeds[0]) : undefined;
        const links = resumed.flatMap((page) => (page.html?.links.internal ?? []).filter((href) => reference && this.#config.follow && URL.canParse(href) && this.#isCrawlable(href, reference)).map((href) => ({ url: href, crawlDepth: page.crawl.depth + 1 })));
        const listed = this.#stragglers().map((url) => ({ url, crawlDepth: 0 }));
        const pooled = [...links, ...listed].filter((candidate) => spread.add(candidate)).length;
        this.#hasStraggled = true;
        log.debug({ resumed: resumed.length, seeds: this.#seeds.size, links: links.length, listed: listed.length, pooled, released: this.#released }, "budget primed");
    }

    // Gives the crawlers the pool’s most diverse candidates while their queues run short and the budget lasts; a drained queue has nothing pending.
    async #refill(isDrained = false): Promise<number> {
        if (!this.#spread) return 0;
        const pending = isDrained ? 0 : Math.max(0, this.#released - this.#handled);
        const left = this.#config.maxPages > 0 ? this.#config.maxPages - this.#released : Infinity;
        const room = Math.min(2 * width(this.#config.concurrency) - pending, left);
        log.debug({ pending, room, released: this.#released, pooled: this.#spread.size, maxPages: this.#config.maxPages, isDrained }, "refill decided");
        if (room <= 0) return 0;
        const batch = this.#spread.take(room);
        this.#released += batch.length;
        await this.#add(batch);
        return batch.length;
    }

    // Queues each request on the crawler its group needs.
    async #add(requests: { url: string; crawlDepth: number }[]): Promise<void> {
        const byCrawler = Object.groupBy(requests, (request) => this.#router.queue(request.url));
        for (const [mode, batch = []] of Object.entries(byCrawler)) {
            log.debug({ crawler: mode, requests: batch.length }, "requests routed");
            await this.#crawlers.get(mode as CrawlerMode)?.addRequests(batch);
        }
    }

    // Finished once every crawler’s queue drains and no sitemap straggler is left to add.
    async #isFinished(): Promise<boolean> {
        for (const crawler of this.#crawlers.values()) {
            const queue = await crawler.getRequestQueue();
            if (!(await queue.isFinished())) return false;
        }
        if ((await this.#refill(true)) > 0) return false;
        if (this.#hasStraggled) return true;
        this.#hasStraggled = true;
        const stragglers = this.#stragglers();
        const isOverBudget = this.#config.maxPages > 0 && this.#handled >= this.#config.maxPages;
        log.debug({ listed: this.#sitemap.size, stragglers: stragglers.length, handled: this.#handled, isOverBudget }, "queue drained");
        if (isOverBudget && stragglers.length > 0) this.cut("max-pages");
        if (isOverBudget || stragglers.length === 0) return true;
        await this.#add(stragglers.map((url) => ({ url, crawlDepth: 0 })));
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
        if (delay > 0) log.info({ delay, origins: origins.length }, `robots.txt asks for ${delay} s between requests, honoured`);
        return delay;
    }

    // Why a seed was never fetched, naming the network error behind an unreachable robots.txt.
    #explainSkippedSeed(seed: string): void {
        const reason = this.#skipped.get(seed);
        if (reason === undefined) return;
        const error = this.#robots.find((facts) => facts.url === `${new URL(seed).origin}/robots.txt`)?.error;
        if (error) log.error({ url: seed, error }, "seed not crawled: its robots.txt is unreachable, which disallows the whole origin (RFC 9309)");
        else log.warn({ url: seed, reason }, `seed not crawled, skipped by its ${reason} check:`);
    }

    // How the crawl ended: complete when nothing was left unfetched, else the first reason of `CRAWL_ENDS` that applies.
    #crawl(): NonNullable<SiteFacts["crawl"]> {
        if (this.#spread && this.#spread.size > 0) this.#cuts.add("max-pages");
        const reason = CRAWL_ENDS.find((end) => this.#cuts.has(end));
        log.debug({ cuts: [...this.#cuts], pooled: this.#spread?.size, reason }, "crawl end decided");
        return reason ? { complete: false, reason } : { complete: true };
    }

    // Crawler options every adapter passes through unchanged; crawlers running side by side split the rate.
    options(mode: CrawlerMode, storage?: CrawlStorage, proxy?: string): { requestQueue?: RequestQueue; autoscaledPoolOptions: { isFinishedFunction: () => Promise<boolean> }; sessionPoolOptions: { blockedStatusCodes: number[] }; requestHandlerTimeoutSecs: number; navigationTimeoutSecs: number; maxRequestsPerCrawl?: number; maxRequestsPerMinute?: number; maxCrawlDepth?: number; proxyConfiguration?: ProxyConfiguration; respectRobotsTxtFile: false | { userAgent: string }; onSkippedRequest: (skip: { url: string; reason: string }) => void } {
        return {
            ...(storage && { requestQueue: storage.queues[mode] }),
            autoscaledPoolOptions: { isFinishedFunction: () => this.#isFinished() },
            // A 401, 403 or 429 is a page to lint, never a session to retire and retry.
            sessionPoolOptions: { blockedStatusCodes: [] },
            requestHandlerTimeoutSecs: this.#config.timeout,
            navigationTimeoutSecs: Math.ceil(this.#config.timeout / 2),
            maxRequestsPerCrawl: this.#config.maxPages || undefined,
            maxRequestsPerMinute: this.#config.rate ? Math.max(1, Math.floor(this.#config.rate / this.#router.crawlers.length)) : undefined,
            ...(proxy && { proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxy] }) }),
            maxCrawlDepth: this.#config.maxDepth || undefined,
            respectRobotsTxtFile: this.#config.robots && { userAgent: "spiderlint" },
            onSkippedRequest: ({ url, reason }) => {
                log.debug({ url, reason }, "link skipped");
                this.#skipped.set(url, reason);
                if (reason === "limit") this.cut("max-pages");
                else if (reason === "depth") this.cut("max-depth");
                if (this.#spread) this.#released = Math.max(0, this.#released - 1);
            },
        };
    }

    // False once --max-pages is spent; otherwise the requested and the loaded URL count as visited.
    admit(request: Request, loaded: URL): boolean {
        this.#handled += 1;
        if (this.#config.maxPages && this.#handled > this.#config.maxPages) {
            log.debug({ url: request.url, handled: this.#handled, maxPages: this.#config.maxPages }, "page dropped past max-pages");
            this.cut("max-pages");
            return false;
        }
        this.#visited.add(request.url);
        this.#visited.add(loaded.href);
        return true;
    }

    // Records that the crawl left pages unfetched for `reason`.
    cut(reason: CrawlEnd): void {
        log.debug({ reason, cuts: [...this.#cuts] }, "crawl cut");
        this.#cuts.add(reason);
    }

    // The facts a page owes to its URL and how the crawl reached it, whatever fetched it; the sitemap entry is the loaded URL’s, else the requested one’s.
    identity(request: Request, url: URL): Pick<Facts, "url" | "group" | "crawl" | "sitemap"> {
        const listing: SitemapFacts | undefined = this.#sitemap.get(url.href) ?? this.#sitemap.get(request.url);
        return {
            url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
            group: "default",
            crawl: { depth: request.crawlDepth, "discovered-via": request.crawlDepth > 0 ? "link" : this.#seeds.has(request.url) ? "seed" : "sitemap", referrers: [], ...(request.url !== url.href && { requested: request.url }) },
            ...(this.#sitemap.size > 0 && { sitemap: listing ?? { listed: false } }),
        };
    }

    // A page no attempt fetched, as status 0 and its error so its referrers still see it; undefined past --max-pages.
    failed(request: Request, error: string): Facts | undefined {
        const url = new URL(request.url);
        if (!this.admit(request, url)) return undefined;
        log.warn({ url: url.href, error, retries: request.retryCount }, "page not fetched");
        return { ...this.identity(request, url), http: { status: 0, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, "content-type": "", error } };
    }

    // Hands a request to the browser before any fetch when its group renders there; true once handed.
    async handOff(request: Request): Promise<boolean> {
        if (!this.#crawlers.has("browser") || !(await this.#router.handOff(request.url))) return false;
        await this.#crawlers.get("browser")?.addRequests([{ url: request.url, crawlDepth: request.crawlDepth }]);
        return true;
    }

    // The page’s anchors and head feeds, or a feed’s targets, queued under the scope and globs on the crawler their group needs, unless the seeds are the whole frontier; returns how many anchors and head feeds were new.
    async enqueue(enqueueLinks: EnqueueLinks, facts: Facts, mode: CrawlerMode): Promise<number> {
        if (!this.#config.follow) return 0;
        const routed: string[] = [];
        const transformRequestFunction: RequestTransform = (request) => {
            const kept = this.transformRequestFunction(request);
            const isRouted = kept && isInScope(new URL(request.url), new URL(facts.url.href), this.#config.scope) && (this.#spread !== undefined || this.#router.queue(request.url) !== mode);
            if (!isRouted) return kept;
            routed.push(request.url);
            return false;
        };
        const options = { strategy: STRATEGY[this.#config.scope], transformRequestFunction };
        const heads = facts.html?.head.links ?? [];
        const feeds = heads.filter((link) => /\balternate\b/i.test(link.rel ?? "") && FEED_TYPES.has(link.type?.toLowerCase() ?? "")).flatMap((link) => (link.href ? [link.href] : []));
        log.debug({ url: facts.url.href, feeds }, "head feeds found");
        const batches = facts.html ? [await enqueueLinks(options), ...(feeds.length > 0 ? [await enqueueLinks({ ...options, urls: feeds })] : [])] : [];
        const targets = feedTargets(facts).filter((url) => URL.canParse(url) && isInScope(new URL(url), new URL(facts.url.href), this.#config.scope) && this.transformRequestFunction({ url } as Parameters<RequestTransform>[0]) !== false);
        log.debug({ url: facts.url.href, targets: targets.length }, "feed targets queued");
        const pooled = await this.#offer([...routed, ...targets], facts.crawl.depth + 1);
        return batches.flatMap((batch) => batch.processedRequests).filter((entry) => !entry.wasAlreadyPresent).length + (this.#spread ? pooled : routed.length);
    }

    // Pages known: every queue’s requests, plus sitemap URLs no link has reached yet, within the page budget.
    async known(): Promise<number> {
        let total = (this.#spread?.size ?? 0) + (this.#hasStraggled ? 0 : this.#stragglers().length);
        for (const crawler of this.#crawlers.values()) {
            const queue = await crawler.getRequestQueue();
            total += queue.getTotalCount();
        }
        return this.#config.maxPages > 0 ? Math.min(total, this.#config.maxPages) : total;
    }

    // What the crawl learnt about the site: how it ended, sitemap files, and each seed origin’s robots.txt when one was read.
    site(): SiteFacts {
        return { sitemaps: this.files, crawl: this.#crawl(), ...(this.#robots.length > 0 && { robots: this.#robots }) };
    }

    // Seeds first, each on its group’s crawler, sitemap stragglers while the budget lasts; robots.txt answered through the robots bucket, a crawl-delay stretched over the crawlers sharing it.
    async run(crawlers: Partial<Record<CrawlerMode, Runnable>>, robots: RobotsFor, resumed: Facts[] = []): Promise<void> {
        if (this.#spread) this.#prime(resumed);
        const answer = (url: string) => (this.#config.robots ? robots(url) : Promise.resolve(undefined));
        const delay = this.#config.robots ? await this.#crawlDelay(robots) : 0;
        const running = Object.entries(crawlers) as [CrawlerMode, Runnable][];
        for (const [mode, crawler] of running) {
            Object.assign(crawler, { getRobotsTxtFileForUrl: answer });
            if (delay > 0) Object.assign(crawler, { sameDomainDelayMillis: delay * 1000 * running.length });
            this.#crawlers.set(mode, crawler);
        }
        const seeds = Object.groupBy(this.#config.seeds, (seed) => this.#router.queue(seed));
        log.debug({ crawlers: running.map(([mode]) => mode), http: seeds.http?.length ?? 0, browser: seeds.browser?.length ?? 0 }, "seeds routed");
        await Promise.all(running.map(([mode, crawler]) => crawler.run(seeds[mode] ?? [])));
        for (const [mode, crawler] of running) {
            const queue = await crawler.getRequestQueue();
            if (this.#config.maxPages === 0 || (await queue.isFinished())) continue;
            log.debug({ crawler: mode, handled: this.#handled }, "queue left requests behind");
            this.cut("max-pages");
        }
        const isRead = this.#config.robots || this.#config.sitemap;
        const files = isRead ? await Promise.all(this.#origins().map(async (origin) => robotsFactsOf(await robots(origin)))) : [];
        this.#robots = files.filter((facts) => facts !== undefined);
        log.debug({ isRead, files: this.#robots.length }, "robots.txt facts collected");
        const reasons = Object.groupBy(this.#skipped.values(), (reason) => reason);
        if (this.#skipped.size > 0) log.debug({ skipped: this.#skipped.size, ...Object.fromEntries(Object.entries(reasons).map(([reason, all]) => [reason, all?.length])) }, "links skipped");
        for (const seed of this.#seeds) this.#explainSkippedSeed(seed);
        const vendors = this.#vendors.entries().map(([entry, tally]) => ({ vendor: entry.vendor, match: entry.match, pages: tally.pages.size, links: tally.links })).toArray();
        if (vendors.length > 0) log.debug({ vendors }, "vendor paths kept out of the crawl");
    }
}
