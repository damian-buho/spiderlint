// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { ConfigError, defaults, type Config, type GroupConfig } from "./config/index.ts";
import type { Stored } from "./cache/http.ts";
import { OfflineMiss, openBucket } from "./cache/index.ts";
import { crawlBrowser } from "./crawl/browser.ts";
import type { Earlier } from "./crawl/frontier.ts";
import { crawlHttp } from "./crawl/http.ts";
import { onOrigin } from "./crawl/scope.ts";
import { robotsLoader } from "./crawl/robots.ts";
import { loadSitemap } from "./crawl/sitemap.ts";
import { attachResources, fetchResources } from "./crawl/resources.ts";
import type { Facts, SiteFacts } from "./facts/types.ts";
import { fold } from "./fold/index.ts";
import { assignGroup, compileGroups } from "./groups/assign.ts";
import { log, logRelativeTo } from "./logger.ts";
import { extract, extractorsFor, isBrowserFact, loadPlugins } from "./plugins/index.ts";
import type { Extractor } from "./plugins/types.ts";
import { compileRulesets, ruleIds } from "./rules/rulesets.ts";
import { runRules, type RuleRun } from "./rules/run.ts";
import type { Finding, Rule } from "./rules/types.ts";
import { DiskStore, lockStore } from "./store/disk.ts";
import { MemoryStore } from "./store/memory.ts";
import { rate, type Checks, type Rating } from "./report/rating.ts";

// What a run spent: browser launches and renders, plain HTTP fetches, resource requests, extractor runs.
export interface Cost {
    browser?: { name: string; launches: number; pages: number };
    http?: { pages: number; revalidated: number };
    resources?: { requests: number; cached: number };
    extractors: Record<string, number>;
}

export interface Summary {
    started: string;
    durationMs: number;
    pages: number;
    bytes: number;
    groups: Record<string, number>;
    statuses: Record<string, number>;
    findings: Record<Finding["severity"], number> & { total: number };
    rules: number;
    checks: Checks;
    rating?: Rating;
    cost: Cost;
}

export interface Report {
    pages: Facts[];
    findings: Finding[];
    summary: Summary;
}

// `default` is the implicit catch-all; top-level `rules` replaces every group's, else a group without `rules` gets `recommended`.
export function groupsOf(config: Config): Record<string, Required<Pick<GroupConfig, "rules">> & GroupConfig> {
    const groups = { ...config.groups };
    groups.default ??= {};
    if (config.rules) log.debug({ rules: config.rules, groups: Object.keys(groups) }, "rules replace every group's rulesets");
    return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, rules: config.rules ?? group.rules ?? ["recommended"] }]));
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

// Each page’s URL on the canonical origin, when there is one and the page is elsewhere; recomputed on every lint.
function twins(pages: Facts[], canonical: string | undefined): void {
    for (const page of pages) {
        const twin = onOrigin(page.url.href, page.url.origin, canonical ?? page.url.origin);
        if (twin === page.url.href) delete page.url.twin;
        else page.url.twin = twin;
    }
    log.debug({ canonical, pages: pages.length }, "twins set");
}

// Occurrences of each key, in first-seen order.
function tally(keys: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
    return counts;
}

// Run totals `human` prints and `json`/`sarif` embed; findings count before folding, so `--unfold` changes none.
function summarize(pages: Facts[], run: RuleRun, rules: number, started: Date, cost: Cost, rulesets: string[]): Summary {
    const checks = { ...run.checks, passed: run.checks.total - run.checks.failed };
    const severities = tally(run.findings.map((finding) => finding.severity));
    const rating = rate(checks, rulesets);
    const statuses = tally(pages.map((page) => String(page.http.status)));
    return {
        started: started.toISOString(),
        durationMs: Date.now() - started.getTime(),
        pages: pages.length,
        bytes: pages.reduce((sum, page) => sum + page.http.size.body, 0),
        groups: tally(pages.map((page) => page.group)),
        statuses: Object.fromEntries(Object.entries(statuses).toSorted(([a], [b]) => Number(a) - Number(b))),
        findings: { total: run.findings.length, error: severities.error ?? 0, warning: severities.warning ?? 0, info: severities.info ?? 0 },
        rules,
        checks,
        ...(rating && { rating }),
        cost,
    };
}

// A --disabled-rules or severity override naming no rule of any group matches nothing; say so.
function warnUnknown(config: Config, groups: Record<string, GroupConfig>): void {
    const known = new Set(Object.values(groups).flatMap((group) => [...ruleIds(group.rules ?? [], config.rulesets)]));
    for (const id of [...config.disabledRules, ...Object.keys(config.overrides)]) {
        if (!known.has(id)) log.warn({ rule: id, known: known.size }, "rule option names no known rule");
    }
}

// Every rule some group runs, flags applied.
function enabledRules(config: Config): Rule[] {
    const disabledRules = new Set(config.disabledRules);
    return Object.values(groupsOf(config)).flatMap((group) => compileRulesets(group.rules, config.rulesets, disabledRules, config.overrides));
}

// Counts one run of each extractor in `ids`.
function counted(cost: Cost, ids: string[]): void {
    for (const id of ids) cost.extractors[id] = (cost.extractors[id] ?? 0) + 1;
}

// Stored pages an extractor never saw get its facts from their stored body, so a new rule needs no re-crawl.
async function backfill(pages: Facts[], store: DiskStore, active: Extractor[], cost: Cost): Promise<void> {
    const unserved = active.filter((extractor) => extractor.mode === "browser" && pages.some((page) => page.html && page[extractor.id] === undefined));
    if (unserved.length > 0) log.warn({ extractors: unserved.map((extractor) => extractor.id) }, "stored pages lack facts only a rendered page gives; re-crawl to add them");
    for (const page of pages) {
        const missing = active.filter((extractor) => page[extractor.id] === undefined);
        if (missing.length === 0) continue;
        const body = await store.body(page.url.href);
        log.debug({ url: page.url.href, extractors: missing.map((extractor) => extractor.id), hasBody: body !== undefined }, "stored page backfilled");
        if (body !== undefined) counted(cost, await extract(page, body, missing));
    }
}

// Why the run needs a browser: each group pinning `browser` and each enabled rule reading a fact only a rendered page has.
function browserReasons(config: Config): string[] {
    const disabledRules = new Set(config.disabledRules);
    return Object.entries(groupsOf(config)).flatMap(([name, group]) => {
        if (group.fetch === "browser") return [`group ${name}`];
        const rules = compileRulesets(group.rules, config.rulesets, disabledRules, config.overrides);
        return rules.filter((rule) => rule.meta.facts.some((fact) => isBrowserFact(fact))).map((rule) => `rule ${rule.meta.id} in group ${name}`);
    });
}

// A pin wins; `auto` renders only when a group or a rule asks for it, and an `http` pin refuses both.
function fetchMode(config: Config): "http" | "browser" {
    if (config.fetch === "adaptive") throw new ConfigError("fetch mode adaptive is not implemented yet; use auto, http or browser");
    if (config.fetch === "browser") return "browser";
    const reasons = browserReasons(config);
    log.debug({ fetch: config.fetch, reasons }, "fetch mode derived");
    if (config.fetch === "http" && reasons.length > 0) throw new ConfigError(`fetch http cannot serve ${reasons.join(", ")}; use --fetch browser or turn them off`);
    return reasons.length > 0 ? "browser" : "http";
}

// What a crawl fetched with; a re-lint against a store crawled otherwise warns.
function crawlHash(config: Config): string {
    const { canonicalOrigin, fetch, browser, scope, maxPages, maxDepth, maxBodySize, include, exclude, robots, sitemap, keepalive, fetchResources: resources, maxResourcesPerPage } = config;
    const shape = { canonicalOrigin, fetch, browser, scope, maxPages, maxDepth, maxBodySize, include, exclude, robots, sitemap, keepalive, resources, maxResourcesPerPage };
    return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

type Lint = (crawled: Crawled, started: Date) => Report;

// Compiles groups and rules up front, so a config error fails before the first request.
function linter(config: Config): Lint {
    const groups = groupsOf(config);
    const matchers = compileGroups(groups);
    const disabledRules = new Set(config.disabledRules);
    const rulesByGroup = new Map<string, Rule[]>(Object.entries(groups).map(([name, group]) => [name, compileRulesets(group.rules, config.rulesets, disabledRules, config.overrides)]));
    const rulesets = [...new Set(Object.values(groups).flatMap((group) => group.rules))];
    const rules = new Set(rulesByGroup.values().toArray().flat().map((rule) => rule.meta.id)).size;
    warnUnknown(config, groups);
    return ({ pages, site, cost }, started) => {
        for (const page of pages) page.group = assignGroup(page, matchers);
        referrers(pages);
        twins(pages, config.canonicalOrigin);
        const run = runRules(pages, rulesByGroup, site);
        const findings = fold(run, config.fold);
        const summary = summarize(pages, run, rules, started, cost, rulesets);
        log.info(summary, "lint done");
        return { pages, findings, summary };
    };
}

export interface Crawled {
    pages: Facts[];
    site: SiteFacts;
    cost: Cost;
}

// The previous crawl’s facts and body for `href`, when the store still holds both.
async function earlierPage(store: DiskStore, href: string): Promise<Earlier | undefined> {
    const facts = store.earlier.get(href);
    const body = facts && (await store.body(facts.url.href));
    return facts && body !== undefined ? { facts, body } : undefined;
}

// `--offline` lints what the store holds and fetches nothing; an empty store is a miss.
async function servedOffline(pages: Facts[], store: DiskStore | undefined, active: Extractor[]): Promise<Crawled> {
    log.info({ pages: pages.length, store: store?.directory }, "serving pages offline");
    if (!store || pages.length === 0) throw new OfflineMiss(`--offline: the pages bucket${store ? ` in ${store.directory}` : ""} is empty; crawl with --store first`);
    const cost: Cost = { extractors: {} };
    await backfill(pages, store, active, cost);
    attachResources(pages, await store.resources());
    return { pages, site: await store.site(), cost };
}

// Fetches pages and their resources; a store also keeps facts, bodies, resource results, site facts and the frontier.
async function crawlPages(config: Config, store?: DiskStore): Promise<Crawled> {
    const memory = new MemoryStore();
    const earlier = store ? await store.pages() : [];
    const active = extractorsFor(enabledRules(config));
    if (config.cacheMode === "offline") return servedOffline(earlier, store, active);
    for (const facts of earlier) memory.add(facts);
    const fetch = fetchMode(config);
    const crawl = fetch === "http" ? crawlHttp : crawlBrowser;
    logRelativeTo(config.seeds);
    const cache = { robots: robotsLoader(openBucket("robots", config, store?.directory)), sitemaps: openBucket<Stored<string>>("sitemaps", config, store?.directory) };
    log.info({ seeds: config.seeds, fetch, scope: config.scope, maxPages: config.maxPages, resumed: earlier.length, store: store?.directory }, "crawl start");
    const cost: Cost = { extractors: {} };
    let fetched = 0;
    let revalidated = 0;
    const { site, launches } = await crawl(
        config,
        async (facts, body, live) => {
            fetched += 1;
            revalidated += facts.http.revalidated ? 1 : 0;
            counted(cost, await extract(facts, body, active, live));
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
    if (fetch === "browser") cost.browser = { name: config.browser, launches, pages: fetched };
    else cost.http = { pages: fetched, revalidated };
    const answered = Object.values(results);
    if (answered.length > 0) cost.resources = { requests: answered.filter((result) => !result.cached).length, cached: answered.filter((result) => result.cached).length };
    log.info({ cost }, "crawl cost");
    return { pages: memory.pages, site, cost };
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
    await loadPlugins(config.plugins);
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
    await loadPlugins(config.plugins);
    return withStore(directory, { fresh: !isResumed && config.cacheMode !== "offline", seeds: config.seeds, configHash: crawlHash(config) }, async (store) => {
        const { pages } = await crawlPages(config, store);
        return pages;
    });
}

// Rules over stored facts with no network; the report is stored for `report`.
export async function lintStore(overrides: Partial<Config>, directory: string): Promise<Report> {
    const started = new Date();
    const config: Config = { ...defaults(), ...overrides };
    await loadPlugins(config.plugins);
    const lint = linter(config);
    return withStore(directory, { fresh: false, configHash: crawlHash(config) }, async (store) => {
        const pages = await store.pages();
        const cost: Cost = { extractors: {} };
        await backfill(pages, store, extractorsFor(enabledRules(config)), cost);
        attachResources(pages, await store.resources());
        const report = lint({ pages, site: await store.site(), cost }, started);
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
        const { index, files } = await loadSitemap(config.seeds, robots, openBucket("sitemaps", config, directory), config.canonicalOrigin);
        const warmed = { origins: new Set(config.seeds.map((seed) => new URL(seed).origin)).size, sitemaps: files.length, urls: index.size };
        log.info(warmed, "cache warmed");
        return warmed;
    } finally {
        await release();
    }
}

export { loadPlugins } from "./plugins/index.ts";
export { definePlugin, type Extractor, type Plugin } from "./plugins/types.ts";

// The last stored report, with the stored facts, for re-formatting.
export async function reportStore(directory: string): Promise<Report> {
    return withStore(directory, { fresh: false }, async (store) => {
        const stored = await store.report();
        return { pages: await store.pages(), findings: stored.findings, summary: stored.summary };
    });
}
