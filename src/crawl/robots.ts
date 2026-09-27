// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { RobotsTxtFile } from "crawlee";
import { fetchCached, type Stored } from "../cache/http.ts";
import { OfflineMiss, type Bucket } from "../cache/index.ts";
import type { ContentSignalFacts, RobotsFileFacts, RobotsGroupFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";

export type RobotsBucket = Bucket<Stored<string>>;
export type RobotsFor = (url: string) => Promise<RobotsTxtFile>;

const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

// Parsed facts per file; Crawlee’s own parser is private, so the body is parsed a second time.
const parsed = new WeakMap<RobotsTxtFile, RobotsFileFacts>();

// `key=value` pairs of a `Content-Signal` line, as written.
function signalsOf(value: string): Record<string, string> {
    const pairs = value.split(",").map((pair) => pair.split("=", 2).map((part) => part.trim()));
    return Object.fromEntries(pairs.filter(([key]) => key).map(([key = "", signal = ""]) => [key.toLowerCase(), signal.toLowerCase()]));
}

// RFC 9309 groups, `Sitemap:` lines and Content Signals; consecutive `User-agent` lines share one group, a rule before any is dropped.
export function parseRobots(url: string, status: number, body: string): RobotsFileFacts {
    const groups: RobotsGroupFacts[] = [];
    const sitemaps: string[] = [];
    const contentSignals: ContentSignalFacts[] = [];
    let group: RobotsGroupFacts | undefined;
    let isOpen = false;
    for (const raw of body.split(/\r\n|\r|\n/)) {
        const line = raw.replace(/#.*/, "").trim();
        const colon = line.indexOf(":");
        if (colon < 1) continue;
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (key === "user-agent") {
            if (!isOpen || !group) groups.push((group = { agents: [], allow: [], disallow: [] }));
            group.agents.push(value.toLowerCase());
            isOpen = true;
            continue;
        }
        isOpen = false;
        if (key === "sitemap") sitemaps.push(value);
        else if (key === "content-signal") contentSignals.push({ agents: group?.agents ?? [], value, signals: signalsOf(value) });
        else if (!group) log.debug({ url, key }, "robots.txt rule outside a group dropped");
        else if (value && (key === "allow" || key === "disallow")) group[key].push(value);
        else if (key === "crawl-delay" && Number.isFinite(Number(value))) group["crawl-delay"] = Number(value);
    }
    log.debug({ url, status, groups: groups.length, sitemaps: sitemaps.length, contentSignals: contentSignals.length }, "robots.txt parsed");
    return { url, status, groups, sitemaps, "content-signals": contentSignals };
}

// The groups naming `agent`, else those naming `*`, as RFC 9309 §2.2.1 picks them.
export function groupsFor(facts: RobotsFileFacts, agent: string): RobotsGroupFacts[] {
    const named = facts.groups.filter((group) => group.agents.includes(agent));
    return named.length > 0 ? named : facts.groups.filter((group) => group.agents.includes("*"));
}

// The `Crawl-delay` the spiderlint group, else the `*` group, asks for; 0 when none.
export function crawlDelayOf(file: RobotsTxtFile): number {
    const facts = parsed.get(file);
    return (facts && groupsFor(facts, "spiderlint").find((group) => group["crawl-delay"] !== undefined)?.["crawl-delay"]) ?? 0;
}

// The file’s facts; a file this module did not load has none.
export function robotsFactsOf(file: RobotsTxtFile): RobotsFileFacts | undefined {
    return parsed.get(file);
}

// RFC 9309 §2.3.1: a 2xx file applies, a 4xx allows everything, a 5xx or no answer disallows everything.
async function load(origin: string, bucket: RobotsBucket): Promise<RobotsTxtFile> {
    const url = `${origin}/robots.txt`;
    let content: string;
    let facts: RobotsFileFacts;
    try {
        const { status, value, cached, revalidated } = await fetchCached(bucket, url, (response) => response.text(), true);
        const isApplied = status >= 200 && status < 300;
        content = isApplied ? value : status >= 400 && status < 500 ? "" : DISALLOW_ALL;
        facts = parseRobots(url, status, isApplied ? value : "");
        log.debug({ url, status, cached, revalidated, isDisallowAll: content === DISALLOW_ALL }, "robots.txt read");
    } catch (error) {
        if (error instanceof OfflineMiss) throw error;
        content = DISALLOW_ALL;
        facts = { ...parseRobots(url, 0, ""), error: reason(error) };
        log.warn({ url, error: reason(error) }, "robots.txt unreachable, disallowing the origin");
    }
    const file = RobotsTxtFile.from(url, content);
    parsed.set(file, facts);
    log.debug({ url, delay: crawlDelayOf(file) }, "robots.txt crawl-delay read");
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
