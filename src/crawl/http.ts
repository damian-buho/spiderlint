// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { CheerioCrawler, Configuration, type RequestQueue, type RequestTransform } from "crawlee";
import type { Readable } from "node:stream";
import picomatch from "picomatch";
import { USER_AGENT } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { capped, isParsed, type Capped } from "./body.ts";
import { extractHtml } from "../facts/html.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, redactHeaders, timingFacts, tlsFacts, type Transport } from "../facts/transport.ts";
import type { Facts, SiteFacts, SitemapFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { bridgeCrawleeLog } from "./log.ts";
import { isInScope, STRATEGY } from "./scope.ts";
import { loadSitemap, type Sitemaps } from "./sitemap.ts";

export type OnPage = (facts: Facts, body: string) => Promise<void> | void;

// Persistent crawl state a store lends the crawler; absent, everything stays in memory.
export interface CrawlStorage {
    config: Configuration;
    requestQueue: RequestQueue;
}

// Only these document types carry html.* facts and links to follow.
const HTML = new Set(["text/html", "application/xhtml+xml"]);

function globMatchers(config: Config): { include: picomatch.Matcher[]; exclude: picomatch.Matcher[] } {
    return { include: config.include.map((glob) => picomatch(glob)), exclude: config.exclude.map((glob) => picomatch(glob)) };
}

// Include and exclude globs run on `pathname + search`, as group matchers do.
function filter(config: Config, skipped: Set<string>): RequestTransform {
    const { include, exclude } = globMatchers(config);
    return (request) => {
        const url = new URL(request.url);
        const path = url.pathname + url.search;
        const reason = include.length > 0 && include.every((match) => !match(path)) ? "include" : exclude.some((match) => match(path)) ? "exclude" : undefined;
        if (!reason) return request;
        log[skipped.has(request.url) ? "debug" : "info"]({ url: request.url, reason }, "link skipped");
        skipped.add(request.url);
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
export async function crawlHttp(config: Config, onPage: OnPage, storage?: CrawlStorage): Promise<SiteFacts> {
    bridgeCrawleeLog();
    const { index: sitemap, files }: Sitemaps = config.sitemap ? await loadSitemap(config.seeds) : { index: new Map(), files: [] };
    const seeds = new Set(config.seeds);
    const visited = new Set<string>();
    const skipped = new Set<string>();
    // Crawlee resets maxRequestsPerCrawl on every run(), so --max-pages needs its own cross-phase tally.
    let handled = 0;
    const transformRequestFunction = filter(config, skipped);
    const bodies = new WeakMap<object, Capped & { source: Transport; tls?: ReturnType<typeof tlsFacts>; remote?: { address: string; family?: string } }>();
    const crawler = new CheerioCrawler(
        {
            additionalMimeTypes: ["*/*"],
            ...(storage && { requestQueue: storage.requestQueue }),
            maxRequestsPerCrawl: config.maxPages || undefined,
            maxCrawlDepth: config.maxDepth || undefined,
            respectRobotsTxtFile: config.robots && { userAgent: "spiderlint" },
            preNavigationHooks: [
                (_context, gotOptions) => {
                    Object.assign(gotOptions, { headers: { ...gotOptions.headers, "user-agent": USER_AGENT } });
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
                    Object.assign(context, { response: cap.stream });
                },
            ],
            onSkippedRequest({ url, reason }) {
                log[skipped.has(url) ? "debug" : "info"]({ url, reason }, "link skipped");
                skipped.add(url);
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
                const isHtml = HTML.has(contentType.type);
                const cap = bodies.get(request);
                const decoded = Buffer.byteLength(body);
                const declared = Number(response.headers["content-length"]);
                const listing: SitemapFacts | undefined = sitemap.get(request.url);
                const facts: Facts = {
                    url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
                    group: "default",
                    crawl: { depth: request.crawlDepth, discoveredVia: request.crawlDepth > 0 ? "link" : seeds.has(request.url) ? "seed" : "sitemap", referrers: [] },
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
                log.debug({ url: url.href, status: facts.http.status, type: contentType.type, bytes: facts.http.size.body, depth: facts.crawl.depth }, "page fetched");
                await onPage(facts, body.toString());
                if (!isHtml) return;
                const { processedRequests } = await enqueueLinks({ strategy: STRATEGY[config.scope], transformRequestFunction });
                log.debug({ url: url.href, enqueued: processedRequests.filter((entry) => !entry.wasAlreadyPresent).length }, "links enqueued");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false }),
    );
    await crawler.run(config.seeds);
    const stragglers = sitemapStragglers(config, sitemap, visited);
    const isOverBudget = config.maxPages > 0 && handled >= config.maxPages;
    if (!isOverBudget && stragglers.length > 0) await crawler.run(stragglers, { purgeRequestQueue: false });
    return { sitemaps: files };
}
