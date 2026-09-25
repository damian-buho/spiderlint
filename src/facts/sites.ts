// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Bucket } from "../cache/index.ts";
import type { Config } from "../config/index.ts";
import type { DnsClient } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { answerOf, type ProbeBucket } from "../crawl/links.ts";
import { probe } from "../crawl/probe.ts";
import { width } from "../crawl/resources.ts";
import { log } from "../logger.ts";
import type { SiteContext, SiteExtractor } from "../plugins/types.ts";
import type { Facts, SiteFacts } from "./types.ts";

const TIMEOUT_MS = 60_000;

const KIND = { origin: "origins", host: "hosts" } as const;

export type SiteBucket = Bucket<unknown>;

// `site.origins.*.<id>…` or `site.hosts.*.<id>…` split into its kind, extractor ID and the path below the subject.
export function subjectPath(fact: string): { kind: "origins" | "hosts"; id: string; path: string } | undefined {
    const match = /^site\.(origins|hosts)\.\*\.(([^.]+).*)$/.exec(fact);
    return match ? { kind: match[1] as "origins" | "hosts", id: match[3] as string, path: match[2] as string } : undefined;
}

// Every origin, or every hostname, the crawl kept pages on, with those pages.
function subjects(pages: Facts[], per: SiteExtractor["per"]): Map<string, Facts[]> {
    return Map.groupBy(pages, (page) => (per === "origin" ? page.url.origin : new URL(page.url.href).hostname));
}

// One subject’s facts, abandoned with its probes once the extractor’s timeout passes.
async function runOne(extractor: SiteExtractor, subject: string, pages: Facts[], config: Pick<Config, "allowPrivate" | "linkExclude">, dns: DnsClient, probes: ProbeBucket): Promise<unknown> {
    const timeout = extractor.timeout ?? TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeout);
    const host = extractor.per === "origin" ? new URL(subject).hostname : subject;
    const context: SiteContext = { pages, signal, fetch: (url, init = {}) => probe(url, init, { host, allowPrivate: config.allowPrivate, signal }), link: async (url) => (({ cached: _cached, ...answer }) => answer)(await answerOf(url, config, probes, signal)), dns: { ...dns, query: (name, type, options) => dns.query(name, type, { ...options, signal }) } };
    const expired = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error(`timed out after ${timeout} ms`)), { once: true }));
    return Promise.race([extractor.extract(subject, context), expired]);
}

// Runs each active extractor once per subject, from `bucket` while fresh, and returns the IDs of every real run.
export async function extractSites(pages: Facts[], site: SiteFacts, active: SiteExtractor[], config: Pick<Config, "allowPrivate" | "concurrency" | "linkExclude">, bucket: SiteBucket, dns: DnsClient, probes: ProbeBucket): Promise<string[]> {
    const jobs = active.flatMap((extractor) => [...subjects(pages, extractor.per)].map(([subject, members]) => ({ extractor, subject, members })));
    log.info({ extractors: active.map((extractor) => extractor.id), jobs: jobs.length }, "site extractors start");
    const ran: string[] = [];
    const queue = jobs.values();
    const worker = async () => {
        for (const { extractor, subject, members } of queue) {
            const key = `${extractor.id}\t${subject}`;
            const entry = extractor.cached === false ? undefined : await bucket.get(key);
            let value = entry && bucket.isFresh(entry) ? entry.value : undefined;
            log.debug({ extractor: extractor.id, subject, cached: value !== undefined }, "site extractor subject");
            if (value === undefined) {
                try {
                    value = await runOne(extractor, subject, members, config, dns, probes);
                    ran.push(extractor.id);
                    if (value !== undefined && extractor.cached !== false) await bucket.set(key, value);
                } catch (error) {
                    log.warn({ extractor: extractor.id, subject, error: reason(error) }, "site extractor failed");
                }
            }
            if (value === undefined) continue;
            const facts = (site[KIND[extractor.per]] ??= {});
            (facts[subject] ??= {})[extractor.id] = value;
        }
    };
    const workers = Array.from({ length: Math.min(width(config.concurrency), jobs.length) }, worker);
    await Promise.all(workers);
    log.info({ runs: ran.length, jobs: jobs.length }, "site extractors done");
    return ran;
}

// Stored site facts cannot be backfilled without the network; name every active extractor they lack, once.
export function warnUnserved(site: SiteFacts, active: SiteExtractor[]): void {
    const unserved = active.filter((extractor) => Object.values(site[KIND[extractor.per]] ?? {}).every((facts) => facts[extractor.id] === undefined));
    log.debug({ active: active.length, unserved: unserved.length }, "stored site facts checked");
    if (unserved.length > 0) log.warn({ extractors: unserved.map((extractor) => extractor.id) }, "stored site facts lack what only a crawl probes; re-crawl to add them");
}
