// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { RobotsTxtFile } from "crawlee";
import robotsModule from "robots-parser";
import { fetchCached, type Stored } from "../cache/http.ts";
import { OfflineMiss, type Bucket } from "../cache/index.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";

export type RobotsBucket = Bucket<Stored<string>>;
export type RobotsFor = (url: string) => Promise<RobotsTxtFile>;

const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

// The CommonJS export is the function itself, which its `export default` typing hides under nodenext.
const robotsParser = robotsModule as unknown as typeof robotsModule.default;

// Crawl-delay seconds per parsed file; Crawlee’s own parser is private, so the body is parsed a second time.
const delays = new WeakMap<RobotsTxtFile, number>();

// The `Crawl-delay` the spiderlint group, else the `*` group, asks for; 0 when none.
export function crawlDelayOf(file: RobotsTxtFile): number {
    return delays.get(file) ?? 0;
}

// RFC 9309 §2.3.1: a 2xx file applies, a 4xx allows everything, a 5xx or no answer disallows everything.
async function load(origin: string, bucket: RobotsBucket): Promise<RobotsTxtFile> {
    const url = `${origin}/robots.txt`;
    let content: string;
    try {
        const { status, value, cached, revalidated } = await fetchCached(bucket, url, (response) => response.text(), true);
        content = status >= 200 && status < 300 ? value : status >= 400 && status < 500 ? "" : DISALLOW_ALL;
        log.debug({ url, status, cached, revalidated, isDisallowAll: content === DISALLOW_ALL }, "robots.txt read");
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        content = DISALLOW_ALL;
        log.warn({ url, error: reason(error) }, "robots.txt unreachable, disallowing the origin");
    }
    const file = RobotsTxtFile.from(url, content);
    const delay = robotsParser(url, content).getCrawlDelay("spiderlint") ?? 0;
    log.debug({ url, delay }, "robots.txt crawl-delay read");
    delays.set(file, delay);
    return file;
}

// One robots.txt per origin for the run, read through `bucket`.
export function robotsLoader(bucket: RobotsBucket): RobotsFor {
    const byOrigin = new Map<string, Promise<RobotsTxtFile>>();
    return (url) => {
        const { origin } = new URL(url);
        if (!byOrigin.has(origin)) byOrigin.set(origin, load(origin, bucket));
        return byOrigin.get(origin) as Promise<RobotsTxtFile>;
    };
}
