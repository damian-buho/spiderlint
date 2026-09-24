#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { DESCRIPTION, VERSION } from "./agent.ts";
import { painter, type Paint } from "./color.ts";
import { OfflineMiss, parseDuration, type CacheMode } from "./cache/index.ts";
import { PURGEABLE, purgeCache } from "./cache/purge.ts";
import { cacheStatus } from "./cache/status.ts";
import { audit, crawl, lintStore, reportStore, warmCache, type Report } from "./index.ts";
import { ConfigError, overlay, defaults, type Config, type FailOn, type FetchMode } from "./config/index.ts";
import { environmentSettings } from "./config/environment.ts";
import { loadSettings, type Settings } from "./config/policy.ts";
import type { Scope } from "./crawl/scope.ts";
import { formatHuman } from "./report/human.ts";
import { formatPresets, formatRules, listPresets, listRules } from "./rules/catalog.ts";
import { formatJson } from "./report/json.ts";
import { formatSarif } from "./report/sarif.ts";
import { log, logColor } from "./logger.ts";

const USAGE = `spiderlint ${VERSION} — ${DESCRIPTION}

Usage: spiderlint <command> [url…] [flags]

Commands:
  audit [url…]          crawl and lint
  crawl [url…]          crawl into --store, lint nothing
  lint                  lint the facts in --store, no network
  report                re-format the report in --store
  facts <url>           one page’s facts as JSON
  groups [url…]         page count per group
  rules [ruleset…]      every rule, its severity here and its docs
  presets               shipped rulesets and whether groups use them
  cache status          entries, bytes and age per bucket
  cache purge [bucket]  delete cached entries
  cache warm [url…]     fetch robots.txt and sitemaps only

Crawl:
  --fetch MODE          auto, http or browser (auto)
  --scope SCOPE         origin, host or domain (origin)
  --max-pages N         page limit, 0 for none (0)
  --max-depth N         link depth limit, 0 for none (0)
  --max-body-size B     body cap in bytes (10000000)
  --include GLOB        crawl matching URLs only, repeatable
  --exclude GLOB        skip matching URLs, repeatable
  --no-robots           ignore robots.txt
  --no-sitemap          skip sitemap discovery
  --no-keepalive        one connection per request
  --no-resources        skip scripts, styles, images and fonts

Rules:
  --config PATH         settings file (projectfile.yaml)
  --disabled-rules IDS  skip these rules
  --error IDS           report these rules as errors
  --warning IDS         report these rules as warnings
  --info IDS            report these rules as info
  --no-fold             one finding per page, never per group

Output:
  --format FORMAT       human, json or sarif (human)
  --fail-on LEVEL       error, warning, info or never (error)
  --[no-]color          force or disable color (auto)

Store and cache:
  --store DIR           store directory (.spiderlint for cache)
  --resume              continue an interrupted crawl
  --older-than AGE      purge entries older than 45s, 30m, 24h, 7d
  --no-cache            neither read nor write the cache
  --refresh             refetch everything, rewrite the cache
  --offline             cache only, a miss exits 3

  -h, --help            show this screen
  -V, --version         show the version

IDS is a comma-separated list of rule IDs.
With no url, targets come from org.spiderlint in the config.
Exit codes: 0 clean, 1 findings, 2 usage, 3 nothing fetched, 4 failure.

Examples:
  spiderlint audit https://example.com/
  spiderlint audit https://example.com/ --format sarif > report.sarif
  spiderlint crawl https://example.com/ --store site
  spiderlint lint --store site --fail-on warning
  spiderlint rules security-headers
  spiderlint cache purge pages --older-than 7d`;

const COMMANDS = new Set(["audit", "crawl", "lint", "report", "facts", "groups", "cache", "rules", "presets"]);
const RANK: Record<FailOn, number> = { never: -1, error: 0, warning: 1, info: 2 };
const FORMATTERS: Record<Config["format"], (report: Report, paint: Paint) => string> = { human: formatHuman, json: formatJson, sarif: formatSarif };

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
    const lines = Object.entries(counts).map(([group, pages]) => `${group}: ${pages} pages`);
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
        ...(values.fetch !== undefined && { fetch: values.fetch as FetchMode }),
        ...(values.scope !== undefined && { scope: values.scope as Scope }),
        ...(values["max-pages"] !== undefined && { maxPages: Number(values["max-pages"]) }),
        ...(values["max-depth"] !== undefined && { maxDepth: Number(values["max-depth"]) }),
        ...(values["max-body-size"] !== undefined && { maxBodySize: Number(values["max-body-size"]) }),
        ...(values.include !== undefined && { include: values.include as string[] }),
        ...(values.exclude !== undefined && { exclude: values.exclude as string[] }),
        ...(values.robots !== undefined && { robots: values.robots as boolean }),
        ...(values.sitemap !== undefined && { sitemap: values.sitemap as boolean }),
        ...(values.keepalive !== undefined && { keepalive: values.keepalive as boolean }),
        ...(values.resources !== undefined && { fetchResources: values.resources as boolean }),
        ...(values.fold !== undefined && { fold: (values.fold as boolean) ? { threshold: 0.8, min: 3 } : false }),
        ...(values["fail-on"] !== undefined && { failOn: values["fail-on"] as FailOn }),
        ...(values.format !== undefined && { format: values.format as Config["format"] }),
        ...(values["disabled-rules"] !== undefined && { disabledRules: splitIds(values["disabled-rules"] as string) }),
        ...(Object.keys(overrides).length > 0 && { overrides }),
        cacheMode: cacheMode(values),
    };
}

// Exit codes: 0 clean, 1 findings, 2 usage or config, 3 no seed fetched or an --offline miss, 4 the run failed.
async function main(argv: string[]): Promise<number> {
    const { values, positionals, tokens } = parseArgs({
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
            fetch: { type: "string" },
            scope: { type: "string" },
            "max-pages": { type: "string" },
            "max-depth": { type: "string" },
            "max-body-size": { type: "string" },
            include: { type: "string", multiple: true },
            exclude: { type: "string", multiple: true },
            robots: { type: "boolean" },
            sitemap: { type: "boolean" },
            keepalive: { type: "boolean" },
            resources: { type: "boolean" },
            fold: { type: "boolean" },
            format: { type: "string" },
            "fail-on": { type: "string" },
            "disabled-rules": { type: "string" },
            error: { type: "string", multiple: true },
            warning: { type: "string", multiple: true },
            info: { type: "string", multiple: true },
        },
    });
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
    const store = values.store;
    const isStored = ["crawl", "lint", "report"].includes(command);
    if (!COMMANDS.has(command) || (command === "facts" && seeds.length === 0) || (isStored && !store) || (command === "cache" && !["status", "purge", "warm"].includes(seeds[0] ?? "")) || (command === "cache" && seeds[0] === "purge" && seeds[1] !== undefined && !PURGEABLE.has(seeds[1]))) {
        console.error(usage(painter(process.stderr, values.color)));
        return 2;
    }
    try {
        if (command === "cache" && seeds[0] === "purge") {
            const olderThan = parseDuration(values["older-than"] ?? "0");
            if (olderThan === undefined) throw new ConfigError(`--older-than: invalid duration ${values["older-than"]} (expected seconds or 45s, 30m, 24h, 7d)`);
            const purged = await purgeCache(store ?? ".spiderlint", seeds[1], olderThan);
            for (const [bucket, count] of Object.entries(purged)) console.log(`${bucket.padEnd(9)} ${String(count).padStart(7)} entries purged`);
            return 0;
        }
        if (command === "cache" && seeds[0] === "status") {
            const buckets = await cacheStatus(store ?? ".spiderlint");
            for (const bucket of buckets) console.log(`${bucket.bucket.padEnd(9)} ${String(bucket.entries).padStart(7)} entries ${String(bucket.bytes).padStart(11)} bytes  ${bucket.oldest} … ${bucket.newest}`);
            return 0;
        }
        const { settings: fileSettings } = loadSettings(values.config ?? process.env.SPIDERLINT_CONFIG);
        let config = overlay(defaults(), fileSettings);
        config = overlay(config, environmentSettings(process.env));
        config = overlay(config, flagSettings(values, tokens));
        if (command === "rules" || command === "presets") {
            const paint = painter(process.stdout, values.color);
            const listed = command === "rules" ? listRules(config, seeds) : listPresets(config);
            if (config.format === "json") console.log(JSON.stringify(listed, undefined, 2));
            else console.log(command === "rules" ? formatRules(listed as ReturnType<typeof listRules>, paint) : formatPresets(listed as ReturnType<typeof listPresets>, paint));
            return 0;
        }
        const targets = command === "cache" ? seeds.slice(1) : seeds;
        if (targets.length > 0) config.seeds = targets;
        const format = FORMATTERS[config.format];
        const failOn = RANK[config.failOn];
        const requiresSeeds = ["audit", "crawl", "groups", "cache"].includes(command);
        if (!format || failOn === undefined || (requiresSeeds && config.seeds.length === 0)) {
            console.error(usage(painter(process.stderr, values.color)));
            return 2;
        }
        if (command === "cache") {
            const warmed = await warmCache(config, store ?? ".spiderlint");
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
            console.log(format(stored, painter(process.stdout, values.color)));
            return exitCode(stored, config.failOn);
        }
        const options = command === "audit" ? { store, resume: values.resume === true } : {};
        const report = await audit({
            ...config,
            maxPages: command === "facts" ? 1 : config.maxPages,
            groups: command === "facts" ? { default: { rules: [] } } : config.groups,
        }, options);
        if (command === "facts") console.log(JSON.stringify(report.pages[0], undefined, 2));
        else if (command === "groups") console.log(groupsOf(report));
        else console.log(format(report, painter(process.stdout, values.color)));
        return command === "audit" ? exitCode(report, config.failOn) : report.pages.length === 0 ? 3 : 0;
    } catch (error) {
        const isConfig = error instanceof ConfigError;
        const isOfflineMiss = error instanceof OfflineMiss;
        log.error({ error: error instanceof Error ? error.message : String(error), isConfig, isOfflineMiss }, "audit aborted");
        return isConfig ? 2 : isOfflineMiss ? 3 : 4;
    }
}

process.exitCode = await main(process.argv.slice(2));
