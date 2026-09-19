#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { audit, type Report } from "./index.ts";
import { overlay, defaults, type Config, type FailOn, type FetchMode } from "./config/index.ts";
import { environmentSettings } from "./config/environment.ts";
import { loadSettings, type Settings } from "./config/policy.ts";
import { resolveDefaultTargets } from "./config/targets.ts";
import type { Scope } from "./crawl/scope.ts";
import { formatHuman } from "./report/human.ts";
import { formatJson } from "./report/json.ts";
import { log } from "./logger.ts";

const USAGE = [
    "usage: spiderlint audit  [url…] [options]   crawl and lint",
    "       spiderlint facts  <url>   [options]   one page’s facts document as JSON",
    "       spiderlint groups [url…] [options]   page count per group",
    "options: --config PATH  --fetch http|browser  --scope origin|host|domain  --max-pages N  --max-depth N",
    "         --include GLOB… --exclude GLOB…  --no-robots  --no-sitemap  --no-fold",
    "         --format human|json  --fail-on error|warning|info|never",
    "         --disabled-rules IDS  --error IDS  --warning IDS  --info IDS  (comma-separated rule IDs)",
    "with no url, audits the projectfile’s homepage and documentation links",
].join("\n");

const RANK: Record<FailOn, number> = { never: -1, error: 0, warning: 1, info: 2 };
const FORMATTERS = { human: formatHuman, json: formatJson };

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

// One `--error`/`--warning`/`--info` flag's repeated occurrences, each possibly comma-separated.
function overrideBucket(raw: string[] | undefined, severity: "error" | "warning" | "info"): Record<string, "error" | "warning" | "info"> {
    return raw === undefined ? {} : Object.fromEntries(raw.flatMap((entry) => splitIds(entry)).map((id) => [id, severity]));
}

// Flags actually passed become a Settings patch; an unset flag leaves the ladder's lower tiers alone.
function flagSettings(values: Record<string, unknown>): Settings {
    const overrideFlags = [values.error, values.warning, values.info] as (string[] | undefined)[];
    return {
        ...(values.fetch !== undefined && { fetch: values.fetch as FetchMode }),
        ...(values.scope !== undefined && { scope: values.scope as Scope }),
        ...(values["max-pages"] !== undefined && { maxPages: Number(values["max-pages"]) }),
        ...(values["max-depth"] !== undefined && { maxDepth: Number(values["max-depth"]) }),
        ...(values.include !== undefined && { include: values.include as string[] }),
        ...(values.exclude !== undefined && { exclude: values.exclude as string[] }),
        ...(values.robots !== undefined && { robots: values.robots as boolean }),
        ...(values.sitemap !== undefined && { sitemap: values.sitemap as boolean }),
        ...(values.fold !== undefined && { fold: (values.fold as boolean) ? { threshold: 0.8, min: 3 } : false }),
        ...(values["fail-on"] !== undefined && { failOn: values["fail-on"] as FailOn }),
        ...(values.format !== undefined && { format: values.format as Config["format"] }),
        ...(values["disabled-rules"] !== undefined && { disabledRules: splitIds(values["disabled-rules"] as string) }),
        ...(overrideFlags.some((value) => value !== undefined) && { overrides: { ...overrideBucket(overrideFlags[0], "error"), ...overrideBucket(overrideFlags[1], "warning"), ...overrideBucket(overrideFlags[2], "info") } }),
    };
}

// Exit codes: 0 clean, 1 findings, 2 usage or config, 3 no seed fetched.
async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        allowNegative: true,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "V" },
            config: { type: "string" },
            fetch: { type: "string" },
            scope: { type: "string" },
            "max-pages": { type: "string" },
            "max-depth": { type: "string" },
            include: { type: "string", multiple: true },
            exclude: { type: "string", multiple: true },
            robots: { type: "boolean" },
            sitemap: { type: "boolean" },
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
        console.log(createRequire(import.meta.url)("../package.json").version);
        return 0;
    }
    const [command, ...seeds] = positionals;
    if (!["audit", "facts", "groups"].includes(command ?? "") || (command === "facts" && seeds.length === 0)) {
        console.error(USAGE);
        return 2;
    }
    try {
        const { settings: fileSettings, document } = loadSettings(values.config ?? process.env.SPIDERLINT_CONFIG);
        let config = overlay(defaults(), fileSettings);
        config = overlay(config, environmentSettings(process.env));
        config = overlay(config, flagSettings(values));
        if (seeds.length > 0) config.seeds = seeds;
        else if (document !== undefined && config.seeds.length === 0) config.seeds = resolveDefaultTargets(document);
        const format = FORMATTERS[config.format];
        const failOn = RANK[config.failOn];
        if (!format || failOn === undefined || (command !== "facts" && config.seeds.length === 0)) {
            console.error(USAGE);
            return 2;
        }
        const report = await audit({
            ...config,
            maxPages: command === "facts" ? 1 : config.maxPages,
            groups: command === "facts" ? { default: { rules: [] } } : config.groups,
        });
        if (command === "facts") console.log(JSON.stringify(report.pages[0], undefined, 2));
        else if (command === "groups") console.log(groupsOf(report));
        else console.log(format(report));
        return command === "audit" ? exitCode(report, config.failOn) : report.pages.length === 0 ? 3 : 0;
    } catch (error) {
        log.error({ error: error instanceof Error ? error.message : String(error) }, "audit aborted");
        return 2;
    }
}

process.exitCode = await main(process.argv.slice(2));
