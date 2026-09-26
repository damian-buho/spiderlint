#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { parseArgs } from "node:util";
import { DESCRIPTION, VERSION } from "./agent.ts";
import { painter, type Paint } from "./color.ts";
import { OfflineMiss, parseDuration, siteDirectory, type CacheMode } from "./cache/index.ts";
import { PURGEABLE, purgeCache } from "./cache/purge.ts";
import { cacheStatus } from "./cache/status.ts";
import { audit, crawl, lintStore, loadPlugins, reportStore, warmCache, type Report } from "./index.ts";
import { ConfigError, originOf, overlay, defaults, proxyOf, type Config, type FailOn } from "./config/index.ts";
import { BROWSERS, environmentSettings, FAIL_ONS, FETCH_MODES, parseInteger, pick, SCOPES } from "./config/environment.ts";
import { loadSettings, type Settings } from "./config/policy.ts";
import { parseResolver } from "./crawl/dns.ts";
import { formatNames, formatter, withSources } from "./plugins/index.ts";
import { NothingStored } from "./store/disk.ts";
import { explainRule, formatExplanation, formatPresets, formatRules, listPresets, listRules } from "./rules/catalog.ts";
import { isLogLevel, log, logColor } from "./logger.ts";

const USAGE = `spiderlint ${VERSION} — ${DESCRIPTION}

Usage: spiderlint <command> [url…] [flags]

Commands:
  audit [url…]          crawl and lint
  crawl [url…]          crawl into the store, lint nothing
  lint [url…]           lint the stored facts, no network
  report [url…]         re-format the stored report
  facts <url>           one page’s facts as JSON, with the site’s
  groups [url…]         page count per group
  rules [ruleset…]      every rule, its severity here and its docs
  presets               shipped rulesets and whether groups use them
  explain <rule>        what a rule reads, expects and how to fix it
  cache status [url…]   entries, bytes and age per bucket
  cache purge [bucket]  delete a site’s cached entries
  cache warm [url…]     fetch robots.txt and sitemaps only

Crawl:
  --fetch MODE          auto, http, browser or adaptive (auto)
  --browser NAME        chromium, firefox or webkit (chromium)
  --scope SCOPE         origin, host or domain (origin)
  --concurrency N       pages in flight, 0 for NUMPROCS, halved in a browser (0)
  --rate N              requests per minute, 0 for no limit (0)
  --proxy URL           http, https or socks5h proxy for every request (none)
  --max-pages N         page limit, 0 for none (0)
  --max-depth N         link depth limit, 0 for none (0)
  --max-body-size B     body cap in bytes (10000000)
  --include GLOB        crawl matching URLs only, repeatable
  --exclude GLOB        skip matching URLs, repeatable
  --source ID:ARG       add a plugin source’s URLs, list:FILE crawls a URL list only, repeatable
  --no-robots           ignore robots.txt
  --no-sitemap          skip sitemap discovery
  --no-keepalive        one connection per request
  --no-resources        skip scripts, styles, images and fonts
  --canonical-origin U  origin the pages are built for; its URLs count as the crawled one’s
  --resolver LIST       DNS servers the dns plugin asks, address[:port],… (system)

Rules:
  --config PATH         settings file (projectfile.yaml)
  --site NAMES          audit these org.spiderlint.sites only, repeatable (all)
  --rules RULESETS      run these rulesets in every group (recommended)
  --disabled-rules IDS  skip these rules
  --error IDS           report these rules as errors
  --warning IDS         report these rules as warnings
  --info IDS            report these rules as info
  --unfold              one finding per page and every URL and location listed

Output:
  --format FORMAT       human, json, sarif, checkstyle, csv or a plugin’s (human)
  --fail-on LEVEL       error, warning, info or never (error)
  --[no-]color          force or disable color (auto)
  --log-level LEVEL     trace, debug, info, warn, error or silent (info)

Store and cache:
  --store DIR           store directory (the site’s, under $XDG_CACHE_HOME/spiderlint)
  --resume              continue an interrupted crawl
  --older-than AGE      purge entries older than 45s, 30m, 24h, 7d
  --no-cache            neither read nor write the cache
  --refresh             refetch everything, rewrite the cache
  --offline             cache only, a miss exits 3

  -h, --help            show this screen
  -V, --version         show the version

IDS and RULESETS are comma-separated; see spiderlint rules and presets.
With no url, targets come from org.spiderlint in the config, one run per site.
Exit codes: 0 clean, 1 findings, 2 usage, 3 nothing fetched, 4 failure.

Examples:
  spiderlint audit https://example.com/
  spiderlint audit https://example.com/ --format sarif > report.sarif
  spiderlint audit https://example.com/ --rules all
  spiderlint audit --source list:urls.txt
  spiderlint crawl https://example.com/
  spiderlint lint https://example.com/ --fail-on warning
  spiderlint rules security-headers
  spiderlint explain html/theme-color-schemes
  spiderlint cache purge pages --older-than 7d`;

const COMMANDS = new Set(["audit", "crawl", "lint", "report", "facts", "groups", "cache", "rules", "presets", "explain"]);
const RANK: Record<FailOn, number> = { never: -1, error: 0, warning: 1, info: 2 };

// Title and headings bold, the command or flag column cyan, a trailing default dim, examples green.
function usage(paint: Paint): string {
    return USAGE.split("\n").map((line, index) => {
        if (index === 0) return line.replace(/^\S+ \S+/, (title) => paint("bold", title));
        if (/^[A-Z][\w ]*:$/.test(line)) return paint("bold", line);
        if (line.startsWith("Usage:")) return line.replace("Usage:", (label) => paint("bold", label));
        if (line.startsWith("  spiderlint ")) return `  ${paint("green", line.slice(2))}`;
        const entry = /^( {2})(\S.*?)( {2,})(.*?)( \([^)]*\))?$/.exec(line);
        if (!entry) return line;
        const [, indent, name = "", gap, text, fallback] = entry;
        return `${indent}${paint("cyan", name)}${gap}${text}${fallback ? paint("dim", fallback) : ""}`;
    }).join("\n");
}

// At most one of --no-cache, --refresh, --offline; undefined when none is passed.
function cacheMode(values: Record<string, unknown>): CacheMode | undefined {
    const modes = [values.cache === false && "off", values.refresh === true && "refresh", values.offline === true && "offline"].filter((mode): mode is CacheMode => mode !== false);
    if (modes.length > 1) throw new ConfigError(`--no-cache, --refresh and --offline exclude each other (got ${modes.join(", ")})`);
    return modes[0];
}

// 1 once any finding reaches --fail-on; 3 when nothing was fetched.
function exitCode(report: Report, failOn: FailOn): number {
    if (report.pages.length === 0) return 3;
    return report.findings.some((finding) => RANK[finding.severity] <= RANK[failOn]) ? 1 : 0;
}

function groupsOf(report: Report): string {
    const counts: Record<string, number> = {};
    for (const page of report.pages) counts[page.group] = (counts[page.group] ?? 0) + 1;
    const modes = new Map(Object.entries(report.summary.fetch ?? {}));
    const lines = Object.entries(counts).map(([group, pages]) => `${group}: ${pages} pages${modes.has(group) ? `, fetch ${modes.get(group)}` : ""}`);
    const fell = report.pages.filter((page) => page.group === "default").map((page) => `  ${page.url.href}`);
    return [...lines, ...(fell.length > 0 ? ["fell through to default:", ...fell] : [])].join("\n");
}

function splitIds(raw: string): string[] {
    return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

type Severity = "error" | "warning" | "info";
type Token = { kind: string; name?: string; value?: string };

const SEVERITIES = new Set<string>(["error", "warning", "info"]);

// `--error`/`--warning`/`--info` in argv order, so the last flag naming a rule wins.
function overridesInOrder(tokens: Token[]): Record<string, Severity> {
    const flags = tokens.filter((token) => token.kind === "option" && SEVERITIES.has(token.name ?? "") && token.value !== undefined);
    return Object.fromEntries(flags.flatMap((token) => splitIds(token.value as string).map((id) => [id, token.name as Severity])));
}

// Flags actually passed become a Settings patch; an unset flag leaves the ladder's lower tiers alone.
function flagSettings(values: Record<string, unknown>, tokens: Token[]): Settings {
    const overrides = overridesInOrder(tokens);
    return {
        ...(values["canonical-origin"] !== undefined && { canonicalOrigin: originOf("--canonical-origin", values["canonical-origin"] as string) }),
        ...(values.resolver !== undefined && { resolver: parseResolver(values.resolver as string) }),
        ...(values.fetch !== undefined && { fetch: pick("--fetch", values.fetch as string, FETCH_MODES) }),
        ...(values.browser !== undefined && { browser: pick("--browser", values.browser as string, BROWSERS) }),
        ...(values.scope !== undefined && { scope: pick("--scope", values.scope as string, SCOPES) }),
        ...(values.concurrency !== undefined && { concurrency: parseInteger("--concurrency", values.concurrency as string) }),
        ...(values.rate !== undefined && { rate: parseInteger("--rate", values.rate as string) }),
        ...(values.proxy !== undefined && { proxy: proxyOf("--proxy", values.proxy as string) }),
        ...(values["max-pages"] !== undefined && { maxPages: parseInteger("--max-pages", values["max-pages"] as string) }),
        ...(values["max-depth"] !== undefined && { maxDepth: parseInteger("--max-depth", values["max-depth"] as string) }),
        ...(values["max-body-size"] !== undefined && { maxBodySize: parseInteger("--max-body-size", values["max-body-size"] as string) }),
        ...(values.include !== undefined && { include: values.include as string[] }),
        ...(values.source !== undefined && { sources: values.source as string[] }),
        ...(values.exclude !== undefined && { exclude: values.exclude as string[] }),
        ...(values.robots !== undefined && { robots: values.robots as boolean }),
        ...(values.sitemap !== undefined && { sitemap: values.sitemap as boolean }),
        ...(values.keepalive !== undefined && { keepalive: values.keepalive as boolean }),
        ...(values.resources !== undefined && { fetchResources: values.resources as boolean }),
        ...(values.unfold !== undefined && { fold: !(values.unfold as boolean) && { threshold: 0.8, min: 3 } }),
        ...(values["fail-on"] !== undefined && { failOn: pick("--fail-on", values["fail-on"] as string, FAIL_ONS) }),
        ...(values.format !== undefined && { format: values.format as string }),
        ...(values["disabled-rules"] !== undefined && { disabledRules: splitIds(values["disabled-rules"] as string) }),
        ...(values.rules !== undefined && { rules: (values.rules as string[]).flatMap((raw) => splitIds(raw)) }),
        ...(Object.keys(overrides).length > 0 && { overrides }),
        cacheMode: cacheMode(values),
    };
}

// One line naming the bad flag, pointing at --help; exit code 2.
function usageError(message: string): number {
    console.error(`spiderlint: ${message} (see spiderlint --help)`);
    return 2;
}

// argv parsed, or the parse error an unknown or malformed flag raises.
function parseFlags(argv: string[]) {
    try {
        return parseArgs({
            args: argv,
            tokens: true,
            allowPositionals: true,
            allowNegative: true,
            options: {
                help: { type: "boolean", short: "h" },
                color: { type: "boolean" },
                version: { type: "boolean", short: "V" },
                config: { type: "string" },
                store: { type: "string" },
                resume: { type: "boolean" },
                cache: { type: "boolean" },
                refresh: { type: "boolean" },
                offline: { type: "boolean" },
                "older-than": { type: "string" },
                "canonical-origin": { type: "string" },
                resolver: { type: "string" },
                fetch: { type: "string" },
                browser: { type: "string" },
                scope: { type: "string" },
                concurrency: { type: "string" },
                rate: { type: "string" },
                proxy: { type: "string" },
                "max-pages": { type: "string" },
                "max-depth": { type: "string" },
                "max-body-size": { type: "string" },
                include: { type: "string", multiple: true },
                source: { type: "string", multiple: true },
                exclude: { type: "string", multiple: true },
                robots: { type: "boolean" },
                sitemap: { type: "boolean" },
                keepalive: { type: "boolean" },
                resources: { type: "boolean" },
                unfold: { type: "boolean" },
                format: { type: "string" },
                "fail-on": { type: "string" },
                "disabled-rules": { type: "string" },
                rules: { type: "string", multiple: true },
                error: { type: "string", multiple: true },
                warning: { type: "string", multiple: true },
                info: { type: "string", multiple: true },
                "log-level": { type: "string" },
                site: { type: "string", multiple: true },
            },
        });
    } catch (error) {
        if (error instanceof TypeError && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS_")) return error;
        throw error;
    }
}

type Flags = Exclude<ReturnType<typeof parseFlags>, TypeError>["values"];

// Exit codes: 0 clean, 1 findings, 2 usage or config, 3 no seed fetched or an --offline miss, 4 the run failed.
async function main(argv: string[]): Promise<number> {
    const parsed = parseFlags(argv);
    if (parsed instanceof Error) return usageError(parsed.message.split(". ", 1)[0] ?? parsed.message);
    const { values, positionals, tokens } = parsed;
    if (values["log-level"] !== undefined && !isLogLevel(values["log-level"])) return usageError(`--log-level: unknown level ${values["log-level"]}`);
    if (values["log-level"] !== undefined) log.level = values["log-level"];
    logColor(values.color);
    if (values.help) {
        console.log(usage(painter(process.stdout, values.color)));
        return 0;
    }
    if (values.version) {
        console.log(VERSION);
        return 0;
    }
    const [command = "", ...seeds] = positionals;
    if (!COMMANDS.has(command) || (command === "facts" && seeds.length === 0) || (command === "explain" && seeds.length !== 1) || (command === "cache" && !["status", "purge", "warm"].includes(seeds[0] ?? ""))) {
        console.error(usage(painter(process.stderr, values.color)));
        return 2;
    }
    try {
        const { settings: fileSettings, sites } = loadSettings(values.config ?? process.env.SPIDERLINT_CONFIG);
        // Shared settings, then the site’s patch, then environment and flags.
        const configFor = (site: Settings): Config => {
            let merged = overlay<Config>(defaults(), fileSettings);
            for (const patch of [site, environmentSettings(process.env), flagSettings(values, tokens)]) merged = overlay<Config>(merged, patch);
            return merged;
        };
        const config = configFor({});
        if (command === "explain") {
            await loadPlugins(config.plugins);
            const explained = explainRule(config, seeds[0] as string);
            console.log(config.format === "json" ? JSON.stringify(explained, undefined, 2) : formatExplanation(explained, painter(process.stdout, values.color)));
            return 0;
        }
        if (command === "rules" || command === "presets") {
            await loadPlugins(config.plugins);
            const paint = painter(process.stdout, values.color);
            const listed = command === "rules" ? listRules(config, seeds) : listPresets(config);
            if (config.format === "json") console.log(JSON.stringify(listed, undefined, 2));
            else console.log(command === "rules" ? formatRules(listed as ReturnType<typeof listRules>, paint) : formatPresets(listed as ReturnType<typeof listPresets>, paint));
            return 0;
        }
        // `cache purge` may name a bucket before its urls.
        const bucket = command === "cache" && seeds[0] === "purge" && PURGEABLE.has(seeds[1] ?? "") ? seeds[1] : undefined;
        const targets = command === "cache" ? seeds.slice(bucket ? 2 : 1) : seeds;
        const named = (values.site ?? []).flatMap((raw) => splitIds(raw));
        const unknown = named.filter((name) => !Object.hasOwn(sites, name));
        if (unknown.length > 0) throw new ConfigError(`--site: unknown site ${unknown.join(", ")} (declared: ${Object.keys(sites).join(", ") || "none"})`);
        // Command-line urls win over every declared site; with none declared the shared settings are the one site.
        const chosen = targets.length > 0 || Object.keys(sites).length === 0 ? [["", {}] as const] : Object.entries(sites).filter(([name]) => named.length === 0 || named.includes(name));
        if (chosen.length > 1 && config.format !== "human") throw new ConfigError(`--format ${config.format}: one document per run, pick a site with --site (declared: ${Object.keys(sites).join(", ")})`);
        let worst = 0;
        for (const [name, site] of chosen) {
            if (name) log.info({ site: name }, "site selected");
            if (name && chosen.length > 1) console.log(`\n${name}`);
            worst = Math.max(worst, await run(command, seeds, targets, bucket, configFor(site), values));
        }
        return worst;
    } catch (error) {
        const isConfig = error instanceof ConfigError;
        const isOfflineMiss = error instanceof OfflineMiss || error instanceof NothingStored;
        log.error({ command, error: error instanceof Error ? error.message : String(error), isConfig, isOfflineMiss }, `${command} aborted`);
        return isConfig ? 2 : isOfflineMiss ? 3 : 4;
    }
}

// One command over one site’s config; the exit code as main documents it.
async function run(command: string, seeds: string[], targets: string[], bucket: string | undefined, config: Config, values: Flags): Promise<number> {
    const isStored = ["crawl", "lint", "report"].includes(command);
    {
        await loadPlugins(config.plugins);
        if (targets.length > 0) config.seeds = targets;
        config = await withSources(config);
        const invalid = config.seeds.find((seed) => !URL.canParse(seed) || !["http:", "https:"].includes(new URL(seed).protocol));
        if (invalid !== undefined) throw new ConfigError(`${invalid}: not an http or https URL`);
        // An explicit --store, else the seeds’ directory in the user cache; `--no-cache` keeps an audit in memory.
        const store = values.store ?? (command === "audit" && config.cacheMode === "off" ? undefined : siteDirectory(config.seeds));
        log.debug({ command, store, seeds: config.seeds.length, cache: config.cacheMode }, "store chosen");
        const formatName = pick("--format", config.format, formatNames());
        const format = formatter(formatName);
        const failOn = RANK[config.failOn];
        const requiresSeeds = ["audit", "crawl", "groups"].includes(command) || (command === "cache" && seeds[0] === "warm");
        if (!format || failOn === undefined || (requiresSeeds && config.seeds.length === 0) || (isStored && !store)) {
            console.error(usage(painter(process.stderr, values.color)));
            return 2;
        }
        if (command === "cache" && seeds[0] === "purge") {
            const olderThan = parseDuration(values["older-than"] ?? "0");
            if (olderThan === undefined) throw new ConfigError(`--older-than: invalid duration ${values["older-than"]} (expected seconds or 45s, 30m, 24h, 7d)`);
            const purged = await purgeCache(store, bucket, olderThan);
            for (const [name, count] of Object.entries(purged)) console.log(`${name.padEnd(9)} ${String(count).padStart(7)} entries purged`);
            return 0;
        }
        if (command === "cache" && seeds[0] === "status") {
            const buckets = await cacheStatus(store);
            for (const entry of buckets) console.log(`${entry.bucket.padEnd(9)} ${String(entry.entries).padStart(7)} entries ${String(entry.bytes).padStart(11)} bytes  ${entry.oldest} … ${entry.newest}`);
            return 0;
        }
        if (command === "cache") {
            const warmed = await warmCache(config, store as string);
            console.log(`${warmed.origins} origins, ${warmed.sitemaps} sitemap files, ${warmed.urls} listed URLs cached`);
            return 0;
        }
        if (command === "crawl") {
            const pages = await crawl(config, store as string, values.resume === true);
            console.log(`${pages.length} pages stored in ${store}`);
            return pages.length === 0 ? 3 : 0;
        }
        if (command === "lint" || command === "report") {
            const stored = command === "lint" ? await lintStore(config, store as string) : await reportStore(store as string);
            console.log(format(stored, painter(process.stdout, values.color), config.fold === false));
            return exitCode(stored, config.failOn);
        }
        const options = command === "audit" ? { store, resume: values.resume === true } : {};
        const report = await audit({
            ...config,
            maxPages: command === "facts" ? 1 : config.maxPages,
            groups: command === "facts" ? { default: { rules: [] } } : config.groups,
        }, options);
        if (command === "facts") console.log(JSON.stringify({ ...report.pages[0], site: report.site }, undefined, 2));
        else if (command === "groups") console.log(groupsOf(report));
        else console.log(format(report, painter(process.stdout, values.color), config.fold === false));
        return command === "audit" ? exitCode(report, config.failOn) : report.pages.length === 0 ? 3 : 0;
    }
}

// Trust the OS store beside Node’s bundled roots, as `node --use-system-ca` does.
const systemRoots = getCACertificates("system");
setDefaultCACertificates([...getCACertificates("default"), ...systemRoots]);
log.debug({ system: systemRoots.length }, "system CA certificates trusted");
process.exitCode = await main(process.argv.slice(2));
