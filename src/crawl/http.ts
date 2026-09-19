// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { CheerioCrawler, Configuration, log as crawleeLog, LogLevel } from "crawlee";
import type { Config } from "../config/index.ts";
import { extractHtml } from "../facts/html.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";

export type OnPage = (facts: Facts) => Promise<void> | void;

// One page per seed, no link discovery yet; storage stays in memory.
export async function crawlHttp(config: Config, onPage: OnPage): Promise<void> {
    crawleeLog.setLevel(LogLevel.WARNING);
    const crawler = new CheerioCrawler(
        {
            maxRequestsPerCrawl: config.maxPages,
            respectRobotsTxtFile: config.robots,
            async requestHandler({ request, response, body, $ }) {
                const url = new URL(request.loadedUrl ?? request.url);
                const facts: Facts = {
                    url: { href: url.href, origin: url.origin, pathname: url.pathname },
                    group: "default",
                    http: {
                        status: response.statusCode ?? 0,
                        headers: response.headers as Record<string, string | string[]>,
                        size: { body: Buffer.byteLength(body) },
                    },
                    html: extractHtml($),
                };
                log.debug({ url: url.href, status: facts.http.status, bytes: facts.http.size.body }, "page fetched");
                await onPage(facts);
            },
            failedRequestHandler({ request }, error) {
                log.error({ url: request.url, error: error.message }, "page failed");
            },
        },
        new Configuration({ persistStorage: false }),
    );
    await crawler.run(config.seeds);
}
