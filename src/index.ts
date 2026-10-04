// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { ConfigError, PROFILES, layered, type Config, type GroupConfig } from "./config/index.ts";
import type { Stored } from "./cache/http.ts";
import { ExtractorCache } from "./cache/extractors.ts";
import { OfflineMiss, openBucket } from "./cache/index.ts";
import type { Earlier } from "./crawl/frontier.ts";
import { crawlSite } from "./crawl/crawl.ts";
import { Router, type GroupMode } from "./crawl/route.ts";
import { onOrigin } from "./crawl/scope.ts";
import { robotsLoader } from "./crawl/robots.ts";
import { loadSitemap, mediaOf } from "./crawl/sitemap.ts";
import { attachResources, fetchResources, isFailure } from "./crawl/resources.ts";
import { probeLinks } from "./crawl/links.ts";
import { openNetwork } from "./crawl/network.ts";
import { probe } from "./crawl/probe.ts";
import { bylineFacts } from "./facts/byline.ts";
import { cspFacts } from "./facts/csp.ts";
import { parsedHeaders } from "./facts/headers.ts";
import { inSpan } from "./telemetry.ts";
import { detectedFacts, loadDetector } from "./facts/language.ts";
import { co2Facts, loadEstimator } from "./facts/co2.ts";
import { robotsFacts } from "./facts/robots.ts";
import { linkGraph } from "./facts/graph.ts";
import { dnsClient, PROXIED_DNS } from "./crawl/dns.ts";
import { extractSites, warnUnserved } from "./facts/sites.ts";
import type { Facts, LinkFacts, SiteFacts } from "./facts/types.ts";
import { servedVersions } from "./facts/transport.ts";
import { attributeVendors, vendorFacts } from "./facts/vendors.ts";
import { fold, HETEROGENEOUS_GUIDE } from "./fold/index.ts";
import { assignGroup, compileGroups } from "./groups/assign.ts";
import { Sampler } from "./groups/sample.ts";
import { log, logRelativeTo } from "./logger.ts";
import { isProgressOn, progressDone } from "./progress.ts";
import { extract, extractorsFor, isBrowserFact, isSampledFact, linkedSiteExtractors, loadPlugins, pageReader, resourceExtractorsFor, siteExtractorsFor } from "./plugins/index.ts";
import type { Extractor, SiteExtractor } from "./plugins/types.ts";
import { compileRulesets, isRuleMatch, ruleIds } from "./rules/rulesets.ts";
import { cell, runRules, type RuleRun } from "./rules/run.ts";
import type { Finding, Rule, RuleGuide } from "./rules/types.ts";
import { stopIfInterrupted } from "./interrupt.ts";
import { DiskStore, lockStore } from "./store/disk.ts";
import { MemoryStore } from "./store/memory.ts";
import { passing, rate, type Checks, type Rating, type RuleChecks } from "./report/rating.ts";
import { factStats, type Stat } from "./report/stats.ts";

const PAGE_CONTEXT_MS = 60_000;

// What a run spent: browser launches and renders, plain HTTP fetches, resource requests, extractor runs and the ones the cache answered.
export interface Cost {
    browser?: { name: string; launches: number; pages: number; tlsProbes: number };
    http?: { pages: number; revalidated: number };
    resources?: { requests: number; cached: number; logged: number; failuresCached?: number };
    extractors: Record<string, number>;
    extractorsCached?: Record<string, number>;
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
    // Checks run, failed and pages covered by each rule that judged anything, so the passing ones are known.
    checked?: Record<string, RuleChecks>;
    rating?: Rating;
    byRule: Record<string, Partial<Record<Finding["severity"], number>>>;
    previous?: { started: string; findings: Summary["findings"] };
    crawlHash?: string;
    // Each group’s fetch mode, an adaptive one as it settled; absent on a re-lint.
    fetch?: Record<string, GroupMode>;
    cost: Cost;
    // Count, min, median, p95, max and total of every numeric page fact.
    stats?: Record<string, Stat>;
}

export interface Report {
    pages: Facts[];
    findings: Finding[];
    summary: Summary;
    site: SiteFacts;
    // What each rule with a finding reads, expects and how to fix it.
    rules?: Record<string, RuleGuide>;
}

// The docs of every rule with a finding or a clean check, from its first compiled instance.
function ruleGuides(findings: Finding[], rulesByGroup: Map<string, Rule[]>, checked: Record<string, RuleChecks> = {}): Record<string, RuleGuide> {
    const found = new Set([...findings.map((finding) => finding.rule), ...passing(checked).map(([id]) => id)]);
    const guides = new Map<string, RuleGuide>();
    for (const { meta } of rulesByGroup.values().toArray().flat()) {
        if (!found.has(meta.id) || guides.has(meta.id)) continue;
        guides.set(meta.id, { facts: meta.facts, ...(meta.expect && { expect: meta.expect }), ...(meta.fix && { fix: meta.fix }), ...(meta.docs && { docs: meta.docs }) });
    }
    if (found.has("groups/heterogeneous")) guides.set("groups/heterogeneous", HETEROGENEOUS_GUIDE);
    log.debug({ rules: guides.size, found: found.size }, "rule guides collected");
    return Object.fromEntries(guides);
}

// `default` is the implicit catch-all, sampling every page; top-level `rules` replaces every group's, else a group without `rules` gets `recommended`.
export function groupsOf(config: Config): Record<string, Required<Pick<GroupConfig, "rules">> & GroupConfig> {
    const groups = { ...config.groups };
    groups.default ??= { sample: "all" };
    if (config.rules) log.debug({ rules: config.rules, groups: Object.keys(groups) }, "rules replace every group's rulesets");
    return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, rules: config.rules ?? group.rules ?? ["recommended"] }]));
}

// A page's referrers are the stored pages linking to it, directly or through a redirect; recomputed from scratch on every lint.
function referrers(pages: Facts[], redirects: Record<string, string> = {}): void {
    const byHref = new Map(pages.map((page) => [page.url.href, page]));
    for (const [from, to] of Object.entries(redirects)) {
        const target = byHref.get(to);
        if (target) byHref.set(from, target);
    }
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
function summarize(pages: Facts[], run: RuleRun, rules: string[], started: Date, cost: Cost, rulesets: string[]): Summary {
    const byRule: Summary["byRule"] = Object.fromEntries(rules.map((id) => [id, {}]));
    for (const { rule, severity } of run.findings) byRule[rule] = { ...byRule[rule], [severity]: (byRule[rule]?.[severity] ?? 0) + 1 };
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
        findings: { total: run.findings.length, error: severities.error ?? 0, warning: severities.warning ?? 0, info: severities.info ?? 0, hint: severities.hint ?? 0 },
        rules: rules.length,
        byRule,
        checks,
        checked: Object.fromEntries(run.perRule.entries().toArray().toSorted(([a], [b]) => a.localeCompare(b))),
        ...(rating && { rating }),
        cost,
        stats: factStats(pages),
    };
}

// The last stored run’s findings over this run’s rules, when it ran every one of them over the same crawl.
function withPrevious(report: Report, { last, manifest }: DiskStore): Report {
    report.summary.crawlHash = manifest.configHash;
    const ids = Object.keys(report.summary.byRule);
    const earlier = last?.byRule ?? {};
    const missing = ids.filter((id) => !Object.hasOwn(earlier, id));
    const isComparable = last !== undefined && missing.length === 0 && last.crawlHash === manifest.configHash;
    log.debug({ last: last?.started, rules: ids.length, missing: missing.length, lastCrawl: last?.crawlHash, crawl: manifest.configHash, isComparable }, "previous run compared");
    if (!last || !isComparable) return report;
    const findings: Summary["findings"] = { total: 0, error: 0, warning: 0, info: 0, hint: 0 };
    for (const id of ids) {
        const counts = Object.entries(earlier[id] ?? {}) as [Finding["severity"], number][];
        for (const [severity, count] of counts) {
            findings[severity] += count;
            findings.total += count;
        }
    }
    report.summary.previous = { started: last.started, findings };
    return report;
}

// Edit distance between `a` and `b`.
function distance(a: string, b: string): number {
    let above = Array.from({ length: b.length + 1 }, (_, column) => column);
    for (const [line, char] of [...a].entries()) {
        const row = [line + 1];
        for (let column = 1; column <= b.length; column++) row.push(Math.min((above[column] as number) + 1, (row[column - 1] as number) + 1, (above[column - 1] as number) + (char === b[column - 1] ? 0 : 1)));
        above = row;
    }
    return above.at(-1) as number;
}

// The known ID or `namespace/*` glob closest to `pattern`, when close enough to be a typo.
function closest(pattern: string, known: Set<string>): string | undefined {
    const candidates = [...known, ...new Set([...known].map((id) => `${id.split("/", 1)[0]}/*`))];
    const [best] = candidates.map((candidate) => ({ candidate, cost: distance(pattern, candidate) })).toSorted((a, b) => a.cost - b.cost);
    return best !== undefined && best.cost <= Math.max(2, Math.floor(pattern.length / 4)) ? best.candidate : undefined;
}

// An --exclude-rules or severity override naming no rule of any group is a typo; refuse to start.
function refuseUnknown(config: Config, groups: Record<string, GroupConfig>): void {
    const known = new Set(Object.values(groups).flatMap((group) => [...ruleIds(group.rules ?? [], config.rulesets)]));
    const unknown = [...config.excludeRules, ...Object.keys(config.overrides)].filter((pattern) => [...known].every((id) => !isRuleMatch(id, pattern)));
    log.debug({ known: known.size, unknown }, "rule options matched");
    if (unknown.length === 0) return;
    const named = unknown.map((pattern) => {
        const guess = closest(pattern, known);
        return guess === undefined ? pattern : `${pattern} (did you mean ${guess}?)`;
    });
    throw new ConfigError(`rule option names no known rule: ${named.join(", ")}; see spiderlint list-rules`);
}

// Each group’s rules, flags applied.
function rulesOf(config: Config): Map<string, Rule[]> {
    const excludeRules = new Set([...config.excludeRules, ...config.denyRules]);
    return new Map(Object.entries(groupsOf(config)).map(([name, group]) => [name, compileRulesets(group.rules, config.rulesets, excludeRules, config.overrides)]));
}

// Every rule some group runs, flags applied.
function enabledRules(config: Config): Rule[] {
    return rulesOf(config).values().toArray().flat();
}

// Whether a rule reads the detected language of a page’s metadata, which needs the detector loaded.
function requiresDetector(rules: Rule[]): boolean {
    return rules.some((rule) => rule.meta.facts.some((fact) => fact.startsWith("html.detected")));
}

// Loads CO2.js, and the language detector when an enabled rule needs it, before the synchronous lint.
async function prepareLint(config: Config): Promise<void> {
    await Promise.all([requiresDetector(enabledRules(config)) && loadDetector(), loadEstimator()]);
}

// A sampler handing each page only the extractors its own group’s rules read.
function samplerOf(config: Config): Sampler {
    const wanted = new Map(rulesOf(config).entries().map(([group, rules]) => [group, new Set(extractorsFor(rules).map((extractor) => extractor.id))]));
    return new Sampler(groupsOf(config), wanted);
}

// Counts one run of each extractor in `ids`.
function counted(cost: Cost, ids: string[]): void {
    for (const id of ids) cost.extractors[id] = (cost.extractors[id] ?? 0) + 1;
}

// The `extractors` bucket for this run, counting into `cost`.
function extractorCache(config: Config, store: DiskStore | undefined, cost: Cost): ExtractorCache {
    cost.extractorsCached = {};
    return new ExtractorCache(openBucket("extractors", config, store?.directory), cost.extractors, cost.extractorsCached);
}

// Stored pages an extractor never saw get its facts from their stored body, the lowest URLs filling each sample, so a new rule needs no re-crawl.
async function backfill(pages: Facts[], store: DiskStore, active: Extractor[], cache: ExtractorCache, sample: Sampler): Promise<void> {
    const ordered = pages.toSorted((a, b) => a.url.href.localeCompare(b.url.href));
    for (const page of ordered) {
        for (const extractor of active) if (page[extractor.id] !== undefined) sample.seed(page, extractor.id);
    }
    const unserved = new Set<string>();
    for (const page of ordered) {
        const missing = sample.take(page, active.filter((extractor) => page[extractor.id] === undefined));
        for (const extractor of missing) if (extractor.mode === "browser" && page.html) unserved.add(extractor.id);
        const runnable = missing.filter((extractor) => extractor.mode !== "browser");
        if (runnable.length === 0) continue;
        const body = await store.body(page.url.href);
        log.debug({ url: page.url.href, extractors: runnable.map((extractor) => extractor.id), hasBody: body !== undefined }, "stored page backfilled");
        if (body === undefined) continue;
        sample.release(page, runnable, await extract(page, body, runnable, cache));
    }
    if (unserved.size > 0) log.warn({ extractors: [...unserved] }, `stored pages lack what ${[...unserved].join(", ")} read from a rendered page; re-crawl to add it`);
}

// Each group’s mode: a run pin wins, else the group’s own, else the run’s; a `browser` pin or a rule reading a rendered-only fact renders, an `http` pin refuses both.
function groupModes(config: Config): Record<string, GroupMode> {
    const excludeRules = new Set([...config.excludeRules, ...config.denyRules]);
    const refused: string[] = [];
    const modes: Record<string, GroupMode> = {};
    const groups = Object.entries(groupsOf(config));
    for (const [name, group] of groups) {
        const rules = compileRulesets(group.rules, config.rulesets, excludeRules, config.overrides);
        const readers = rules.filter((rule) => rule.meta.facts.some((fact) => isBrowserFact(fact))).map((rule) => `rule ${rule.meta.id} in group ${name}`);
        const pin = config.fetch === "http" || config.fetch === "browser" ? config.fetch : (group.fetch ?? config.fetch);
        const isPinnedAbove = config.fetch === "http" && (group.fetch === "browser" || group.fetch === "adaptive");
        if (pin === "http") refused.push(...readers, ...(isPinnedAbove ? [`group ${name}`] : []));
        const isDetected = pin === "adaptive" && PROFILES[config.profile]?.adaptive !== false;
        modes[name] = pin === "browser" || readers.length > 0 ? "browser" : isDetected ? "adaptive" : "http";
        log.debug({ group: name, fetch: config.fetch, pin, profile: config.profile, readers, mode: modes[name] }, "group fetch mode derived");
    }
    if (refused.length > 0) throw new ConfigError(`fetch http cannot serve ${refused.join(", ")}; use --fetch browser or turn them off`);
    return modes;
}

// What a crawl fetched with; a re-lint against a store crawled otherwise warns.
function crawlHash(config: Config): string {
    const { canonicalOrigin, fetch, browser, scope, maxPages, maxDepth, maxBodySize, includeUrls: include, excludeUrls: exclude, vendorPaths, robots, sitemap, keepalive, fetchResources: resources, maxResourcesPerPage, follow } = config;
    const groupFetch = Object.fromEntries(Object.entries(config.groups).flatMap(([name, group]) => (group.fetch ? [[name, group.fetch]] : [])));
    const shape = { canonicalOrigin, fetch, ...(Object.keys(groupFetch).length > 0 && { groupFetch }), browser, scope, maxPages, maxDepth, maxBodySize, include, exclude, ...(!vendorPaths && { vendorPaths }), robots, sitemap, keepalive, resources, maxResourcesPerPage, ...(!follow && { follow }) };
    return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

// (group, rule) cells whose rule reads an expensive extractor’s facts in a group larger than its sample.
function sampledCells(pages: Facts[], rulesByGroup: Map<string, Rule[]>, groups: Record<string, GroupConfig>): Set<string> {
    const sample = new Sampler(groups);
    const sizes = tally(pages.map((page) => page.group));
    const cells = [...rulesByGroup].flatMap(([group, rules]) => rules.filter((rule) => (sizes[group] ?? 0) > sample.cap(group) && rule.meta.facts.some((fact) => isSampledFact(fact))).map((rule) => cell(group, rule.meta.id)));
    log.debug({ cells }, "sampled cells");
    return new Set(cells);
}

type Lint = (crawled: Crawled, started: Date) => Report;

// Whether a page or depth limit may have left pages uncrawled.
function isCapped(config: Config, pages: Facts[]): boolean {
    const isCut = (config.maxPages > 0 && pages.length >= config.maxPages) || (config.maxDepth > 0 && pages.some((page) => page.crawl.depth >= config.maxDepth));
    log.debug({ maxPages: config.maxPages, maxDepth: config.maxDepth, pages: pages.length, isCut }, "crawl limits checked");
    return isCut;
}

// Findings of rules reading the link graph say it is partial.
function capped(run: RuleRun, rulesByGroup: Map<string, Rule[]>): void {
    const readers = new Set(rulesByGroup.values().toArray().flat().filter((rule) => rule.meta.facts.some((fact) => fact.startsWith("graph."))).map((rule) => rule.meta.id));
    const partial = run.findings.filter((finding) => readers.has(finding.rule));
    for (const finding of partial) finding.message += "; the crawl stopped at a limit, so the page may sit closer and have more links in";
    log.debug({ rules: [...readers], findings: partial.length }, "graph findings marked partial");
}

// Facts derived from the stored ones on every lint: group, robots, CSP, parsed headers, byline, CO2, the detected language when asked, referrers, twins, role, vendor paths and the link graph.
function derive(pages: Facts[], site: SiteFacts, config: Config, matchers: ReturnType<typeof compileGroups>, isDetected: boolean): void {
    for (const page of pages) {
        page.group = assignGroup(page, matchers);
        page.robots = robotsFacts(page);
        const csp = cspFacts(page);
        if (csp) page.http.csp = csp;
        const parsed = parsedHeaders(page.url.href, page.http.headers);
        if (parsed) page.http.parsed = parsed;
        const detected = isDetected && page.html && detectedFacts(page.html);
        if (detected && page.html) page.html.detected = detected;
        if (page.html) Object.assign(page.html, bylineFacts(page.html));
        const co2 = page.html ? co2Facts(page) : undefined;
        if (co2) page.co2 = co2;
    }
    servedVersions(pages);
    referrers(pages, site.redirects);
    twins(pages, config.canonicalOrigin);
    site.role = config.role;
    vendorFacts(pages, site, config.vendorPaths);
    site.graph = linkGraph(pages, site.redirects, isCapped(config, pages));
}

// Compiles groups and rules up front, so a config error fails before the first request.
function linter(config: Config): Lint {
    const groups = groupsOf(config);
    const matchers = compileGroups(groups);
    const rulesByGroup = rulesOf(config);
    const rulesets = [...new Set(Object.values(groups).flatMap((group) => group.rules))];
    const rules = [...new Set(rulesByGroup.values().toArray().flat().map((rule) => rule.meta.id))].toSorted((a, b) => a.localeCompare(b));
    refuseUnknown(config, groups);
    const isDetected = requiresDetector(rulesByGroup.values().toArray().flat());
    const parity = rules.filter((id) => rulesByGroup.values().some((group) => group.some((rule) => rule.meta.id === id && rule.meta.facts.some((fact) => fact === "parity" || fact.startsWith("parity.")))));
    return ({ pages, site, cost, fetch }, started) => {
        stopIfInterrupted("lint");
        const unrendered = parity.length > 0 ? pages.filter((page) => page.html && !page.parity).length : 0;
        if (unrendered > 0) log.info({ rules: parity, pages: unrendered }, `${parity.join(", ")} skipped on ${unrendered} pages crawled over http; --fetch browser renders them`);
        derive(pages, site, config, matchers, isDetected);
        const run = runRules(pages, rulesByGroup, site);
        if (site.graph?.capped) capped(run, rulesByGroup);
        run.sampled = sampledCells(pages, rulesByGroup, groups);
        const findings = fold(run, config.fold);
        attributeVendors(findings, config.vendorPaths);
        const summary = { ...summarize(pages, run, rules, started, cost, rulesets), ...(fetch && { fetch }) };
        log.debug(summary, "lint summary");
        log.debug({ pages: summary.pages, findings: summary.findings.total, grade: summary.rating?.grade, durationMs: summary.durationMs }, "lint done");
        return { pages, findings, summary, site, rules: ruleGuides(findings, rulesByGroup, summary.checked) };
    };
}

export interface Crawled {
    pages: Facts[];
    site: SiteFacts;
    cost: Cost;
    fetch?: Record<string, GroupMode>;
}

// The previous crawl’s facts and body for `href`, when the store still holds both.
async function earlierPage(store: DiskStore, href: string): Promise<Earlier | undefined> {
    const facts = store.earlier.get(href);
    const body = facts && (await store.body(facts.url.href));
    return facts && body !== undefined ? { facts, body } : undefined;
}

// `--offline` lints what the store holds and fetches nothing; an empty store is a miss.
async function servedOffline(pages: Facts[], store: DiskStore | undefined, active: Extractor[], siteActive: SiteExtractor[], sample: Sampler, config: Config): Promise<Crawled> {
    log.debug({ pages: pages.length, store: store?.directory }, "serving pages offline");
    if (!store || pages.length === 0) throw new OfflineMiss(`--offline: the pages bucket${store ? ` in ${store.directory}` : ""} is empty; crawl with --store first`);
    const cost: Cost = { extractors: {} };
    await backfill(pages, store, active, extractorCache(config, store, cost), sample);
    attachResources(pages, await store.resources());
    const site = await store.site();
    warnUnserved(site, siteActive);
    return { pages, site, cost };
}

// Fetches with the run’s network open: paced, and proxied when configured.
async function crawlPages(config: Config, store?: DiskStore): Promise<Crawled> {
    const network = await openNetwork(config);
    try {
        return await crawlOpen(config, store, network.proxy);
    } finally {
        await network.close();
    }
}

// Site extractors a proxied run can serve: none that queries DNS past the proxy.
function proxied(active: SiteExtractor[], config: Config): SiteExtractor[] {
    const skipped = config.proxy ? active.filter((extractor) => extractor.resolves) : [];
    if (skipped.length > 0) log.warn({ extractors: skipped.map((extractor) => extractor.id) }, `${skipped.map((extractor) => extractor.id).join(", ")} skipped: their DNS queries would bypass the proxy`);
    return active.filter((extractor) => !skipped.includes(extractor));
}

// Fetches pages and their resources; a store also keeps facts, bodies, resource results, site facts and the frontier.
async function crawlOpen(given: Config, store: DiskStore | undefined, proxy: string | undefined): Promise<Crawled> {
    const memory = new MemoryStore();
    const earlier = store ? await store.pages() : [];
    const rules = enabledRules(given);
    const reader = pageReader(rules);
    const isSeeded = given.follow && rules.length > 0 && !reader;
    const config = isSeeded ? { ...given, follow: false } : given;
    const active = extractorsFor(rules);
    const siteActive = proxied(siteExtractorsFor(rules), config);
    const sample = samplerOf(config);
    if (config.cacheMode === "offline") return servedOffline(earlier, store, active, siteActive, sample, config);
    stopIfInterrupted("crawl");
    for (const facts of earlier) memory.add(facts);
    const router = new Router(groupsOf(config), groupModes(config));
    const resourceActive = resourceExtractorsFor(rules);
    const isKeptType = (type: string) => resourceActive.some((extractor) => extractor.types.some((prefix) => type.startsWith(prefix)));
    logRelativeTo(config.seeds);
    const cache = { robots: robotsLoader(openBucket("robots", config, store?.directory)), sitemaps: openBucket<Stored<string>>("sitemaps", config, store?.directory) };
    const robots = config.robots ? cache.robots : undefined;
    log.debug({ seeds: config.seeds, fetch: config.fetch, scope: config.scope, maxPages: config.maxPages, follow: config.follow, followedFor: config.follow ? reader : undefined, resumed: earlier.length, store: store?.directory }, "crawl start");
    const cost: Cost = { extractors: {} };
    const extractors = extractorCache(config, store, cost);
    const redirects: Record<string, string> = {};
    const { site, pages, revalidated, launches, responses, tlsProbes, modes } = await crawlSite(
        config,
        async (facts, body, live) => inSpan("page", { "url.full": facts.url.href, "http.response.status_code": facts.http.status }, async () => {
            if (proxy) delete facts.http.remote;
            if (facts.crawl.requested && facts.http.redirects.length > 0) redirects[facts.crawl.requested] = facts.url.href;
            const chosen = sample.take(facts, active);
            const signal = AbortSignal.timeout(PAGE_CONTEXT_MS);
            const context = { signal, fetch: (url: string, init = {}) => probe(url, init, { host: new URL(facts.url.href).hostname, allowPrivate: config.allowPrivate, signal, robots }) };
            const extracting = performance.now();
            const added = await extract(facts, body, chosen, extractors, live, context);
            sample.release(facts, chosen, added);
            if (memory.add(facts)) await store?.add(facts, body);
            progressDone(memory.pages.length);
            log[isProgressOn() ? "debug" : "info"]({ page: facts.url.href, status: facts.http.status, pages: memory.pages.length, extractors: added, extractMs: Math.round(performance.now() - extracting) }, "page done");
        }),
        cache,
        router,
        store && { config: store.config, queues: store.frontiers, earlier: (href) => earlierPage(store, href) },
        proxy,
        isKeptType,
        active.some((extractor) => extractor.debugging),
        active.some((extractor) => extractor.mode === "browser" && extractor.cost === "expensive"),
    );
    stopIfInterrupted("resources");
    site.redirects = redirects;
    log.debug({ redirects: Object.keys(redirects).length }, "redirects recorded");
    await store?.pruneBodies(memory.pages);
    const results = await fetchResources(memory.pages, config, openBucket("resources", config, store?.directory), resourceActive, responses, extractors);
    await store?.saveResources(results);
    const isProbed = rules.some((rule) => rule.meta.id === "links/broken-external");
    const isMediaProbed = rules.some((rule) => rule.meta.id === "sitemap/media");
    log.debug({ isProbed, isMediaProbed }, "external link probes decided");
    const probes = openBucket<LinkFacts>("probes", config, store?.directory);
    const links = memory.pages.flatMap((page) => [...(isProbed ? (page.html?.links.external ?? []) : []), ...(isMediaProbed ? mediaOf(page) : [])]);
    stopIfInterrupted("link probes");
    if (isProbed || isMediaProbed) site.links = await probeLinks(links, config, probes);
    stopIfInterrupted("site extractors");
    const dns = config.proxy ? PROXIED_DNS : dnsClient(config.resolver, openBucket("dns", config, store?.directory), config.allowPrivate);
    counted(cost, await extractSites(memory.pages, site, siteActive, config, openBucket("origins", config, store?.directory), dns, probes, robots, linkedSiteExtractors(rules)));
    await store?.saveSite(site);
    attachResources(memory.pages, results);
    if (pages.browser !== undefined) cost.browser = { name: config.browser, launches, pages: pages.browser, tlsProbes };
    if (pages.http !== undefined) cost.http = { pages: pages.http, revalidated };
    const answered = Object.values(results);
    const failuresCached = answered.filter((result) => result.cached && isFailure(result.status)).length;
    if (answered.length > 0) cost.resources = { requests: answered.filter((result) => !result.cached && !result.logged).length, cached: answered.filter((result) => result.cached).length, logged: answered.filter((result) => result.logged).length, ...(failuresCached > 0 && { failuresCached }) };
    log.debug({ cost }, "crawl cost");
    return { pages: memory.pages, site, cost, fetch: modes };
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

// Throws ConfigError for a ruleset, rule ID or rule option naming nothing the configured plugins define; nothing is fetched.
export async function validateRules(overrides: Partial<Config>): Promise<void> {
    const config = layered([overrides]);
    await loadPlugins(config.plugins, config.pluginSettings);
    refuseUnknown(config, groupsOf(config));
}

export interface StoreOptions {
    store?: string;
    resume?: boolean;
}

// crawl → facts → group → rules → fold; `store` keeps everything on disk for `lint` and `show-report`.
export async function audit(overrides: Partial<Config>, options: StoreOptions = {}): Promise<Report> {
    const started = new Date();
    const config = layered([overrides]);
    await loadPlugins(config.plugins, config.pluginSettings);
    const lint = linter(config);
    await prepareLint(config);
    const persist = async (store: DiskStore) => {
        const report = withPrevious(lint(await crawlPages(config, store), started), store);
        await store.saveReport({ findings: report.findings, summary: report.summary, rules: report.rules });
        return report;
    };
    const isFresh = !options.resume && config.cacheMode !== "offline";
    return options.store ? withStore(options.store, { fresh: isFresh, seeds: config.seeds, configHash: crawlHash(config) }, persist) : lint(await crawlPages(config), started);
}

// Accumulate only: fetch into `directory` and lint nothing.
export async function crawl(overrides: Partial<Config>, directory: string, isResumed = false): Promise<Facts[]> {
    const config = layered([overrides]);
    await loadPlugins(config.plugins, config.pluginSettings);
    return withStore(directory, { fresh: !isResumed && config.cacheMode !== "offline", seeds: config.seeds, configHash: crawlHash(config) }, async (store) => {
        const { pages } = await crawlPages(config, store);
        return pages;
    });
}

// Rules over stored facts with no network; the report is stored for `show-report`.
export async function lintStore(overrides: Partial<Config>, directory: string): Promise<Report> {
    const started = new Date();
    const config = layered([overrides]);
    await loadPlugins(config.plugins, config.pluginSettings);
    const lint = linter(config);
    await prepareLint(config);
    return withStore(directory, { fresh: false, existing: true, configHash: crawlHash(config) }, async (store) => {
        const pages = await store.pages();
        const cost: Cost = { extractors: {} };
        const rules = enabledRules(config);
        await backfill(pages, store, extractorsFor(rules), extractorCache(config, store, cost), samplerOf(config));
        attachResources(pages, await store.resources());
        const site = await store.site();
        warnUnserved(site, siteExtractorsFor(rules));
        const report = withPrevious(lint({ pages, site, cost }, started), store);
        await store.saveReport({ findings: report.findings, summary: report.summary, rules: report.rules });
        return report;
    });
}

// Every stored page’s facts and the site document, derived as a lint derives them, with no network and no rule run.
export async function factsStore(overrides: Partial<Config>, directory: string): Promise<Crawled> {
    const config = layered([overrides]);
    await loadPlugins(config.plugins, config.pluginSettings);
    await Promise.all([loadDetector(), loadEstimator()]);
    return withStore(directory, { fresh: false, existing: true }, async (store) => {
        const pages = await store.pages();
        attachResources(pages, await store.resources());
        const site = await store.site();
        derive(pages, site, config, compileGroups(groupsOf(config)), true);
        log.debug({ pages: pages.length, store: directory }, "stored facts read");
        return { pages, site, cost: { extractors: {} } };
    });
}

// Reads every seed origin’s robots.txt and sitemaps into their buckets, crawling nothing.
export async function warmCache(overrides: Partial<Config>, directory: string): Promise<{ origins: number; sitemaps: number; urls: number }> {
    const config = layered([overrides]);
    const release = await lockStore(directory);
    const network = await openNetwork(config);
    try {
        logRelativeTo(config.seeds);
        const robots = robotsLoader(openBucket("robots", config, directory));
        const { index, files } = await loadSitemap(config.seeds, robots, openBucket("sitemaps", config, directory), config.canonicalOrigin);
        const warmed = { origins: new Set(config.seeds.map((seed) => new URL(seed).origin)).size, sitemaps: files.length, urls: index.size };
        log.debug(warmed, "cache warmed");
        return warmed;
    } finally {
        await network.close();
        await release();
    }
}

export { loadPlugins } from "./plugins/index.ts";
export { definePlugin, type Extractor, type Plugin, type SiteContext, type SiteExtractor } from "./plugins/types.ts";

// The last stored report, with the stored facts, for re-formatting.
export async function reportStore(directory: string): Promise<Report> {
    return withStore(directory, { fresh: false, existing: true }, async (store) => {
        const stored = await store.report();
        return { pages: await store.pages(), findings: stored.findings, summary: stored.summary, site: await store.site(), ...(stored.rules && { rules: stored.rules }) };
    });
}
