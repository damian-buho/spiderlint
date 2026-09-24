#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { VERSION } from "./agent.ts";
import { OfflineMiss, parseDuration, type CacheMode } from "./cache/index.ts";
import { PURGEABLE, purgeCache } from "./cache/purge.ts";
import { cacheStatus } from "./cache/status.ts";
import { audit, crawl, lintStore, reportStore, type Report } from "./index.ts";
import { ConfigError, overlay, defaults, type Config, type FailOn, type FetchMode } from "./config/index.ts";
import { environmentSettings } from "./config/environment.ts";
import { loadSettings, type Settings } from "./config/policy.ts";
import { resolveDefaultTargets } from "./config/targets.ts";
import type { Scope } from "./crawl/scope.ts";
import { formatHuman } from "./report/human.ts";
import { formatJson } from "./report/json.ts";
import { formatSarif } from "./report/sarif.ts";
import { log } from "./logger.ts";

const USAGE = [
    "usage: spiderlint audit  [url…] [--store DIR] [options]   crawl and lint",
    "       spiderlint crawl  [url…]  --store DIR  [options]   crawl into a store, lint nothing",
    "       spiderlint lint           --store DIR  [options]   rules over stored facts, no network",
    "       spiderlint report         --store DIR  [options]   re-format the stored report",
    "       spiderlint facts  <url>   [options]   one page’s facts document as JSON",
    "       spiderlint groups [url…] [options]   page count per group",
    "       spiderlint cache status  [--store DIR]   entries, bytes and age per bucket (default .spiderlint)",
    "       spiderlint cache purge [bucket] [--older-than 7d] [--store DIR]   delete cached entries",
    "options: --config PATH  --fetch http|browser  --scope origin|host|domain  --max-pages N  --max-depth N  --max-body-size BYTES",
    "         --include GLOB… --exclude GLOB…  --no-robots  --no-sitemap  --no-fold  --no-keepalive  --no-resources",
    "         --format human|json|sarif  --fail-on error|warning|info|never  --resume  --no-cache  --refresh  --offline",
    "         --disabled-rules IDS  --error IDS  --warning IDS  --info IDS  (comma-separated rule IDs)",
    "with no url, audits the projectfile’s homepage and documentation links",
].join("\n");

const COMMANDS = new Set(["audit", "crawl", "lint", "report", "facts", "groups", "cache"]);
const RANK: Record<FailOn, number> = { never: -1, error: 0, warning: 1, info: 2 };
const FORMATTERS = { human: formatHuman, json: formatJson, sarif: formatSarif };

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
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    if (values.version) {
        console.log(VERSION);
        return 0;
    }
    const [command = "", ...seeds] = positionals;
    const store = values.store;
    const isStored = ["crawl", "lint", "report"].includes(command);
    if (!COMMANDS.has(command) || (command === "facts" && seeds.length === 0) || (isStored && !store) || (command === "cache" && !["status", "purge"].includes(seeds[0] ?? "")) || (command === "cache" && seeds[1] !== undefined && !PURGEABLE.has(seeds[1]))) {
        console.error(USAGE);
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
        if (command === "cache") {
            const buckets = await cacheStatus(store ?? ".spiderlint");
            for (const bucket of buckets) console.log(`${bucket.bucket.padEnd(9)} ${String(bucket.entries).padStart(7)} entries ${String(bucket.bytes).padStart(11)} bytes  ${bucket.oldest} … ${bucket.newest}`);
            return 0;
        }
        const { settings: fileSettings, document } = loadSettings(values.config ?? process.env.SPIDERLINT_CONFIG);
        let config = overlay(defaults(), fileSettings);
        config = overlay(config, environmentSettings(process.env));
        config = overlay(config, flagSettings(values, tokens));
        if (seeds.length > 0) config.seeds = seeds;
        else if (document !== undefined && config.seeds.length === 0) config.seeds = resolveDefaultTargets(document);
        const format = FORMATTERS[config.format];
        const failOn = RANK[config.failOn];
        const requiresSeeds = ["audit", "crawl", "groups"].includes(command);
        if (!format || failOn === undefined || (requiresSeeds && config.seeds.length === 0)) {
            console.error(USAGE);
            return 2;
        }
        if (command === "crawl") {
            const pages = await crawl(config, store as string, values.resume === true);
            console.log(`${pages.length} pages stored in ${store}`);
            return pages.length === 0 ? 3 : 0;
        }
        if (command === "lint" || command === "report") {
            const stored = command === "lint" ? await lintStore(config, store as string) : await reportStore(store as string);
            console.log(format(stored));
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
        else console.log(format(report));
        return command === "audit" ? exitCode(report, config.failOn) : report.pages.length === 0 ? 3 : 0;
    } catch (error) {
        const isConfig = error instanceof ConfigError;
        const isOfflineMiss = error instanceof OfflineMiss;
        log.error({ error: error instanceof Error ? error.message : String(error), isConfig, isOfflineMiss }, "audit aborted");
        return isConfig ? 2 : isOfflineMiss ? 3 : 4;
    }
}

process.exitCode = await main(process.argv.slice(2));
