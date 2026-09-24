// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { defaults, type Config, type GroupConfig } from "./config/index.ts";
import type { Stored } from "./cache/http.ts";
import { OfflineMiss, openBucket } from "./cache/index.ts";
import { crawlBrowser } from "./crawl/browser.ts";
import { crawlHttp, type Earlier } from "./crawl/http.ts";
import { robotsLoader } from "./crawl/robots.ts";
import { loadSitemap } from "./crawl/sitemap.ts";
import { attachResources, fetchResources } from "./crawl/resources.ts";
import type { Facts, SiteFacts } from "./facts/types.ts";
import { fold } from "./fold/index.ts";
import { assignGroup, compileGroups } from "./groups/assign.ts";
import { log, logRelativeTo } from "./logger.ts";
import { compileRulesets, ruleIds } from "./rules/rulesets.ts";
import { runRules } from "./rules/run.ts";
import type { Finding, Rule } from "./rules/types.ts";
import { DiskStore, lockStore } from "./store/disk.ts";
import { MemoryStore } from "./store/memory.ts";

export interface Summary {
    started: string;
    durationMs: number;
    pages: number;
    bytes: number;
    groups: Record<string, number>;
    statuses: Record<string, number>;
    findings: number;
}

export interface Report {
    pages: Facts[];
    findings: Finding[];
    summary: Summary;
}

// `default` is the implicit catch-all; a group without `rules` gets `recommended`.
function groupsOf(config: Config): Record<string, Required<Pick<GroupConfig, "rules">> & GroupConfig> {
    const groups = { ...config.groups };
    groups.default ??= {};
    return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, rules: group.rules ?? ["recommended"] }]));
}

// A page's referrers are the stored pages linking to it; recomputed from scratch on every lint.
function referrers(pages: Facts[]): void {
    const byHref = new Map(pages.map((page) => [page.url.href, page]));
    for (const page of pages) page.crawl.referrers = [];
    for (const page of pages) {
        const internal = page.html?.links.internal ?? [];
        for (const href of internal) byHref.get(href)?.crawl.referrers.push(page.url.href);
    }
}

// Occurrences of each key, in first-seen order.
function tally(keys: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
    return counts;
}

// Run totals `human` prints and `json`/`sarif` embed.
function summarize(pages: Facts[], findings: Finding[], started: Date): Summary {
    const statuses = tally(pages.map((page) => String(page.http.status)));
    return {
        started: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        pages: pages.length,
        bytes: pages.reduce((sum, page) => sum + page.http.size.body, 0),
        groups: tally(pages.map((page) => page.group)),
        statuses: Object.fromEntries(Object.entries(statuses).toSorted(([a], [b]) => Number(a) - Number(b))),
        findings: findings.length,
    };
}

// A --disabled-rules or severity override naming no rule of any group matches nothing; say so.
function warnUnknown(config: Config, groups: Record<string, GroupConfig>): void {
    const known = new Set(Object.values(groups).flatMap((group) => [...ruleIds(group.rules ?? [], config.rulesets)]));
    for (const id of [...config.disabledRules, ...Object.keys(config.overrides)]) {
        if (!known.has(id)) log.warn({ rule: id, known: known.size }, "rule option names no known rule");
    }
}

// What a crawl fetched with; a re-lint against a store crawled otherwise warns.
function crawlHash(config: Config): string {
    const { fetch, scope, maxPages, maxDepth, maxBodySize, include, exclude, robots, sitemap, keepalive, fetchResources: resources, maxResourcesPerPage } = config;
    const shape = { fetch, scope, maxPages, maxDepth, maxBodySize, include, exclude, robots, sitemap, keepalive, resources, maxResourcesPerPage };
    return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

type Lint = (crawled: Crawled, started: Date) => Report;

// Compiles groups and rules up front, so a config error fails before the first request.
function linter(config: Config): Lint {
    const groups = groupsOf(config);
    const matchers = compileGroups(groups);
    const disabledRules = new Set(config.disabledRules);
    const rulesByGroup = new Map<string, Rule[]>(Object.entries(groups).map(([name, group]) => [name, compileRulesets(group.rules, config.rulesets, disabledRules, config.overrides)]));
    warnUnknown(config, groups);
    return ({ pages, site }, started) => {
        for (const page of pages) page.group = assignGroup(page, matchers);
        referrers(pages);
        const findings = fold(runRules(pages, rulesByGroup, site), config.fold);
        const summary = summarize(pages, findings, started);
        log.info(summary, "lint done");
        return { pages, findings, summary };
    };
}

export interface Crawled {
    pages: Facts[];
    site: SiteFacts;
}

// The previous crawl’s facts and body for `href`, when the store still holds both.
async function earlierPage(store: DiskStore, href: string): Promise<Earlier | undefined> {
    const facts = store.earlier.get(href);
    const body = facts && (await store.body(facts.url.href));
    return facts && body !== undefined ? { facts, body } : undefined;
}

// `--offline` lints what the store holds and fetches nothing; an empty store is a miss.
async function servedOffline(pages: Facts[], store: DiskStore | undefined): Promise<Crawled> {
    log.info({ pages: pages.length, store: store?.directory }, "serving pages offline");
    if (!store || pages.length === 0) throw new OfflineMiss(`--offline: the pages bucket${store ? ` in ${store.directory}` : ""} is empty; crawl with --store first`);
    attachResources(pages, await store.resources());
    return { pages, site: await store.site() };
}

// Fetches pages and their resources; a store also keeps facts, bodies, resource results, site facts and the frontier.
async function crawlPages(config: Config, store?: DiskStore): Promise<Crawled> {
    const memory = new MemoryStore();
    const earlier = store ? await store.pages() : [];
    if (config.cacheMode === "offline") return servedOffline(earlier, store);
    for (const facts of earlier) memory.add(facts);
    const crawl = config.fetch === "http" ? crawlHttp : crawlBrowser;
    logRelativeTo(config.seeds);
    const cache = { robots: robotsLoader(openBucket("robots", config, store?.directory)), sitemaps: openBucket<Stored<string>>("sitemaps", config, store?.directory) };
    log.info({ seeds: config.seeds, fetch: config.fetch, scope: config.scope, maxPages: config.maxPages, resumed: earlier.length, store: store?.directory }, "crawl start");
    const site = await crawl(
        config,
        async (facts, body) => {
            if (memory.add(facts)) await store?.add(facts, body);
        },
        cache,
        store && { config: store.config, requestQueue: store.frontier, earlier: (href) => earlierPage(store, href) },
    );
    await store?.pruneBodies(memory.pages);
    const results = await fetchResources(memory.pages, config, openBucket("resources", config, store?.directory));
    await store?.saveResources(results);
    await store?.saveSite(site);
    attachResources(memory.pages, results);
    return { pages: memory.pages, site };
}

// Runs `work` against a locked store, stamping it finished only when `work` succeeds.
async function withStore<T>(directory: string, mode: Parameters<typeof DiskStore.open>[1], work: (store: DiskStore) => Promise<T>): Promise<T> {
    const store = await DiskStore.open(directory, mode);
    let isFinished = false;
    try {
        const result = await work(store);
        isFinished = true;
        return result;
    } finally {
        await store.close(isFinished);
    }
}

export interface StoreOptions {
    store?: string;
    resume?: boolean;
}

// crawl → facts → group → rules → fold; `store` keeps everything on disk for `lint` and `report`.
export async function audit(overrides: Partial<Config>, options: StoreOptions = {}): Promise<Report> {
    const started = new Date();
    const config: Config = { ...defaults(), ...overrides };
    const lint = linter(config);
    const persist = async (store: DiskStore) => {
        const report = lint(await crawlPages(config, store), started);
        await store.saveReport({ findings: report.findings, summary: report.summary });
        return report;
    };
    const isFresh = !options.resume && config.cacheMode !== "offline";
    return options.store ? withStore(options.store, { fresh: isFresh, seeds: config.seeds, configHash: crawlHash(config) }, persist) : lint(await crawlPages(config), started);
}

// Accumulate only: fetch into `directory` and lint nothing.
export async function crawl(overrides: Partial<Config>, directory: string, isResumed = false): Promise<Facts[]> {
    const config: Config = { ...defaults(), ...overrides };
    return withStore(directory, { fresh: !isResumed && config.cacheMode !== "offline", seeds: config.seeds, configHash: crawlHash(config) }, async (store) => {
        const { pages } = await crawlPages(config, store);
        return pages;
    });
}

// Rules over stored facts with no network; the report is stored for `report`.
export async function lintStore(overrides: Partial<Config>, directory: string): Promise<Report> {
    const started = new Date();
    const config: Config = { ...defaults(), ...overrides };
    const lint = linter(config);
    return withStore(directory, { fresh: false, configHash: crawlHash(config) }, async (store) => {
        const pages = await store.pages();
        attachResources(pages, await store.resources());
        const report = lint({ pages, site: await store.site() }, started);
        await store.saveReport({ findings: report.findings, summary: report.summary });
        return report;
    });
}

// Reads every seed origin’s robots.txt and sitemaps into their buckets, crawling nothing.
export async function warmCache(overrides: Partial<Config>, directory: string): Promise<{ origins: number; sitemaps: number; urls: number }> {
    const config: Config = { ...defaults(), ...overrides };
    const release = await lockStore(directory);
    try {
        logRelativeTo(config.seeds);
        const robots = robotsLoader(openBucket("robots", config, directory));
        const { index, files } = await loadSitemap(config.seeds, robots, openBucket("sitemaps", config, directory));
        const warmed = { origins: new Set(config.seeds.map((seed) => new URL(seed).origin)).size, sitemaps: files.length, urls: index.size };
        log.info(warmed, "cache warmed");
        return warmed;
    } finally {
        await release();
    }
}

// The last stored report, with the stored facts, for re-formatting.
export async function reportStore(directory: string): Promise<Report> {
    return withStore(directory, { fresh: false }, async (store) => {
        const stored = await store.report();
        return { pages: await store.pages(), findings: stored.findings, summary: stored.summary };
    });
}
