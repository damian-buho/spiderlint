// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { CheerioCrawler, Configuration, type RequestTransform } from "crawlee";
import picomatch from "picomatch";
import type { Config } from "../config/index.ts";
import { extractHtml } from "../facts/html.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { bridgeCrawleeLog } from "./log.ts";
import { STRATEGY } from "./scope.ts";

export type OnPage = (facts: Facts) => Promise<void> | void;

// Only these document types carry html.* facts and links to follow.
const HTML = new Set(["text/html", "application/xhtml+xml"]);

// Include and exclude globs run on `pathname + search`, as group matchers do.
function filter(config: Config, skipped: Set<string>): RequestTransform {
    const include = config.include.map((glob) => picomatch(glob));
    const exclude = config.exclude.map((glob) => picomatch(glob));
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

// Fetches seeds, follows in-scope links through the frontier; storage stays in memory.
export async function crawlHttp(config: Config, onPage: OnPage): Promise<void> {
    bridgeCrawleeLog();
    const skipped = new Set<string>();
    const transformRequestFunction = filter(config, skipped);
    const crawler = new CheerioCrawler(
        {
            additionalMimeTypes: ["*/*"],
            maxRequestsPerCrawl: config.maxPages || undefined,
            maxCrawlDepth: config.maxDepth || undefined,
            respectRobotsTxtFile: config.robots,
            onSkippedRequest({ url, reason }) {
                log[skipped.has(url) ? "debug" : "info"]({ url, reason }, "link skipped");
                skipped.add(url);
            },
            async requestHandler({ request, response, body, $, contentType, enqueueLinks }) {
                const url = new URL(request.loadedUrl ?? request.url);
                const isHtml = HTML.has(contentType.type);
                const facts: Facts = {
                    url: { href: url.href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: url.search },
                    group: "default",
                    crawl: { depth: request.crawlDepth, discoveredVia: request.crawlDepth === 0 ? "seed" : "link", referrers: [] },
                    http: {
                        status: response.statusCode ?? 0,
                        headers: response.headers as Record<string, string | string[]>,
                        size: { body: Buffer.byteLength(body) },
                        contentType: contentType.type,
                        ...(contentType.encoding && { charset: contentType.encoding }),
                    },
                    ...(isHtml && { html: extractHtml($, url, config.scope) }),
                };
                log.debug({ url: url.href, status: facts.http.status, type: contentType.type, bytes: facts.http.size.body, depth: facts.crawl.depth }, "page fetched");
                await onPage(facts);
                if (!isHtml) return;
                const { processedRequests } = await enqueueLinks({ strategy: STRATEGY[config.scope], transformRequestFunction });
                log.debug({ url: url.href, enqueued: processedRequests.filter((entry) => !entry.wasAlreadyPresent).length }, "links enqueued");
            },
        },
        new Configuration({ persistStorage: false }),
    );
    await crawler.run(config.seeds);
}
