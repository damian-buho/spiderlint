// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { CheerioCrawler, Configuration, type CheerioCrawlerOptions, type RequestQueue, type RequestTransform, type RobotsTxtFile } from "crawlee";
import type { Readable } from "node:stream";
import picomatch from "picomatch";
import { USER_AGENT } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { capped, isParsed, replayed, type Capped } from "./body.ts";
import { extractHtml } from "../facts/html.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, redactHeaders, timingFacts, tlsFacts, type Transport } from "../facts/transport.ts";
import type { Facts, SiteFacts, SitemapFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { bridgeCrawleeLog } from "./log.ts";
import { isInScope, STRATEGY } from "./scope.ts";
import type { RobotsFor } from "./robots.ts";
import { loadSitemap, type SitemapBucket, type Sitemaps } from "./sitemap.ts";

export type OnPage = (facts: Facts, body: string) => Promise<void> | void;

// Cached lookups a crawl reads through.
export interface CrawlCache {
    robots: RobotsFor;
    sitemaps: SitemapBucket;
}

// Crawlee’s robots.txt checks, answered through the robots bucket with the spiderlint user agent.
class Crawler extends CheerioCrawler {
    readonly #robots: RobotsFor | undefined;

    constructor(options: CheerioCrawlerOptions, storageConfig: Configuration, robots: RobotsFor | undefined) {
        super(options, storageConfig);
        this.#robots = robots;
    }

    protected override getRobotsTxtFileForUrl(url: string): Promise<RobotsTxtFile | undefined> {
        return this.#robots ? this.#robots(url) : Promise.resolve(undefined);
    }
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

// The first value of a header that may repeat.
function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

// `If-None-Match` and `If-Modified-Since` from a stored page’s `ETag` and `Last-Modified`.
function validators(headers: Facts["http"]["headers"]): Record<string, string> {
    const etag = first(headers.etag);
    const modified = first(headers["last-modified"]);
    return { ...(etag && { "if-none-match": etag }), ...(modified && { "if-modified-since": modified }) };
}

// A 304 keeps the stored status, size and cookies and merges its headers over the stored ones.
function revalidated(earlier: Facts, fresh: Facts): Facts["http"] {
    const cookies = fresh.http.cookies.length > 0 ? fresh.http.cookies : earlier.http.cookies;
    const headers = { ...earlier.http.headers, ...fresh.http.headers };
    return { ...fresh.http, status: earlier.http.status, size: earlier.http.size, headers, cookies, revalidated: true };
}

// The stored `Content-Type` header, else one rebuilt from the stored type and charset.
function storedContentType(facts: Facts): string {
    return first(facts.http.headers["content-type"]) ?? `${facts.http.contentType}${facts.http.charset ? `; charset=${facts.http.charset}` : ""}`;
}

// Only these document types carry html.* facts and links to follow.
const HTML = new Set(["text/html", "application/xhtml+xml"]);

function globMatchers(config: Config): { include: picomatch.Matcher[]; exclude: picomatch.Matcher[] } {
    return { include: config.include.map((glob) => picomatch(glob)), exclude: config.exclude.map((glob) => picomatch(glob)) };
}

// Include and exclude globs run on `pathname + search`, as group matchers do.
function filter(config: Config, skipped: Map<string, string>): RequestTransform {
    const { include, exclude } = globMatchers(config);
    return (request) => {
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const reason = include.length > 0 && include.every((match) => !match(path)) ? "include" : exclude.some((match) => match(path)) ? "exclude" : undefined;
        if (!reason) return request;
        log.debug({ url: request.url, reason }, "link skipped");
        skipped.set(request.url, reason);
        return false;
    };
}

// A sitemap URL still unvisited once the link crawl settles joins the frontier as its own root.
function sitemapStragglers(config: Config, index: Sitemaps["index"], visited: Set<string>): string[] {
    if (index.size === 0 || config.seeds.length === 0) return [];
    const reference = new URL(config.seeds[0] as string);
    const { include, exclude } = globMatchers(config);
    const extra = index
        .keys()
        .filter((href) => {
            if (visited.has(href)) return false;
            const url = new URL(href);
            if (!isInScope(url, reference, config.scope)) return false;
            const path = url.pathname + url.search;
            return (include.length === 0 || include.some((match) => match(path))) && exclude.every((match) => !match(path));
        })
        .toArray();
    log.debug({ listed: index.size, unvisited: extra.length }, "sitemap stragglers");
    return extra;
}

// Wire bytes received so far, from got's progress on the original response stream.
function transferred(source: unknown): number | undefined {
    return (source as { downloadProgress?: { transferred?: number } }).downloadProgress?.transferred;
}

// The response's own connection, read while it is still attached.
function socketOf(source: unknown): Transport["socket"] {
    const stream = source as { socket?: Transport["socket"]; request?: { socket?: Transport["socket"] } };
    return stream.socket ?? stream.request?.socket;
}

// Fetches seeds, follows in-scope links through the frontier; storage stays in memory.
export async function crawlHttp(config: Config, onPage: OnPage, cache: CrawlCache, storage?: CrawlStorage): Promise<SiteFacts> {
    bridgeCrawleeLog();
    const { index: sitemap, files }: Sitemaps = config.sitemap ? await loadSitemap(config.seeds, cache.robots, cache.sitemaps) : { index: new Map(), files: [] };
    const seeds = new Set(config.seeds);
    const visited = new Set<string>();
    const skipped = new Map<string, string>();
    // Crawlee resets maxRequestsPerCrawl on every run(), so --max-pages needs its own cross-phase tally.
    let handled = 0;
    const transformRequestFunction = filter(config, skipped);
    const revalidating = new WeakMap<object, Earlier>();
    let revalidatedPages = 0;
    const bodies = new WeakMap<object, Capped & { source: Transport; tls?: ReturnType<typeof tlsFacts>; remote?: { address: string; family?: string } }>();
    const crawler = new Crawler(
        {
            additionalMimeTypes: ["*/*"],
            ...(storage && { requestQueue: storage.requestQueue }),
            maxRequestsPerCrawl: config.maxPages || undefined,
            maxCrawlDepth: config.maxDepth || undefined,
            respectRobotsTxtFile: config.robots && { userAgent: "spiderlint" },
            preNavigationHooks: [
                async ({ request }, gotOptions) => {
                    Object.assign(gotOptions, { headers: { ...gotOptions.headers, "user-agent": USER_AGENT } });
                    const earlier = config.cacheMode === "use" ? await storage?.earlier?.(request.url) : undefined;
                    const conditional = earlier ? validators(earlier.facts.http.headers) : {};
                    log.debug({ url: request.url, isStored: earlier !== undefined, conditional: Object.keys(conditional) }, "page revalidation decided");
                    if (earlier && Object.keys(conditional).length > 0) {
                        revalidating.set(request, earlier);
                        Object.assign(gotOptions, { headers: { ...gotOptions.headers, ...conditional } });
                    }
                    if (config.keepalive) return;
                    Object.assign(gotOptions, { http2: false, headers: { ...gotOptions.headers, connection: "close" } });
                },
            ],
            postNavigationHooks: [
                (context) => {
                    const source = context.response as unknown as Readable & { headers: Record<string, string | undefined> };
                    const contentType = source.headers["content-type"];
                    const max = isParsed(contentType) ? config.maxBodySize : 0;
                    const cap = capped(source, max);
                    log.debug({ url: context.request.url, contentType, max }, "body capped");
                    const socket = socketOf(source);
                    const address = socket?.remoteAddress ?? (source as Transport).ip;
                    const remote = address ? { address, ...(socket?.remoteFamily && { family: socket.remoteFamily }) } : undefined;
                    bodies.set(context.request, { ...cap, source: source as Transport, tls: tlsFacts(socket), remote });
                    const earlier = (source as unknown as { statusCode?: number }).statusCode === 304 ? revalidating.get(context.request) : undefined;
                    log.debug({ url: context.request.url, isReplayed: earlier !== undefined }, "page body chosen");
                    Object.assign(context, { response: earlier ? replayed(cap.stream, earlier.body, storedContentType(earlier.facts)) : cap.stream });
                },
            ],
            onSkippedRequest({ url, reason }) {
                log.debug({ url, reason }, "link skipped");
                skipped.set(url, reason);
            },
            async requestHandler({ request, response, body, $, contentType, enqueueLinks }) {
                handled += 1;
                if (config.maxPages && handled > config.maxPages) {
                    log.debug({ url: request.url, handled, maxPages: config.maxPages }, "page dropped past max-pages");
                    return;
                }
                visited.add(request.url);
                const url = new URL(request.loadedUrl ?? request.url);
                visited.add(url.href);
                const earlier = response.statusCode === 304 ? revalidating.get(request) : undefined;
                const isHtml = HTML.has(contentType.type);
                const cap = bodies.get(request);
                const decoded = Buffer.byteLength(body);
                const declared = Number(response.headers["content-length"]);
                const listing: SitemapFacts | undefined = sitemap.get(request.url);
                const facts: Facts = {
                    url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
                    group: "default",
                    crawl: { depth: request.crawlDepth, discoveredVia: request.crawlDepth > 0 ? "link" : seeds.has(request.url) ? "seed" : "sitemap", referrers: [], ...(request.url !== url.href && { requested: request.url }) },
                    ...(sitemap.size > 0 && { sitemap: listing ?? { listed: false } }),
                    http: {
                        status: response.statusCode ?? 0,
                        ...(cap?.source.httpVersion && { version: cap.source.httpVersion }),
                        redirects: (cap?.source.redirectUrls ?? []).map((redirect) => ({ url: String(redirect) })),
                        headers: redactHeaders(response.headers),
                        ...(cap?.remote && { remote: cap.remote }),
                        timing: cap ? timingFacts(cap.source) : {},
                        cookies: cookieFacts(response.headers["set-cookie"]),
                        size: {
                            body: transferred(cap?.source) ?? decoded,
                            decoded,
                            ...(Number.isSafeInteger(declared) && { declared }),
                            ...(cap?.isTruncated() && { truncated: true as const }),
                        },
                        contentType: contentType.type,
                        ...(contentType.encoding && { charset: contentType.encoding }),
                    },
                    ...(cap?.tls && { tls: cap.tls }),
                    ...(isHtml && { html: extractHtml($, url, config.scope), resources: extractResources($, url, config.maxResourcesPerPage) }),
                };
                if (earlier) facts.http = revalidated(earlier.facts, facts);
                revalidatedPages += earlier ? 1 : 0;
                log.debug({ url: url.href, status: facts.http.status, type: facts.http.contentType, bytes: facts.http.size.body, depth: facts.crawl.depth, revalidated: facts.http.revalidated }, "page fetched");
                await onPage(facts, body.toString());
                if (!isHtml) return;
                const { processedRequests } = await enqueueLinks({ strategy: STRATEGY[config.scope], transformRequestFunction });
                log.debug({ url: url.href, enqueued: processedRequests.filter((entry) => !entry.wasAlreadyPresent).length }, "links enqueued");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false }),
        config.robots ? cache.robots : undefined,
    );
    await crawler.run(config.seeds);
    const stragglers = sitemapStragglers(config, sitemap, visited);
    const isOverBudget = config.maxPages > 0 && handled >= config.maxPages;
    if (!isOverBudget && stragglers.length > 0) await crawler.run(stragglers, { purgeRequestQueue: false });
    if (revalidatedPages > 0) log.info({ revalidated: revalidatedPages, handled }, "pages revalidated");
    const reasons = Object.groupBy(skipped.values(), (reason) => reason);
    if (skipped.size > 0) log.info({ skipped: skipped.size, ...Object.fromEntries(Object.entries(reasons).map(([reason, all]) => [reason, all?.length])) }, "links skipped");
    return { sitemaps: files };
}
