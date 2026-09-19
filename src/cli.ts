#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { audit, type Report } from "./index.ts";
import type { FailOn, FetchMode } from "./config/index.ts";
import type { Scope } from "./crawl/scope.ts";
import { formatHuman } from "./report/human.ts";
import { formatJson } from "./report/json.ts";
import { log } from "./logger.ts";

const USAGE = [
    "usage: spiderlint audit  <url…> [options]   crawl and lint",
    "       spiderlint facts  <url>   [options]   one page’s facts document as JSON",
    "       spiderlint groups <url…> [options]   page count per group",
    "options: --fetch http|browser  --scope origin|host|domain  --max-pages N  --max-depth N",
    "         --include GLOB… --exclude GLOB…  --no-robots  --no-fold",
    "         --format human|json  --fail-on error|warning|info|never",
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

// Exit codes: 0 clean, 1 findings, 2 usage or config, 3 no seed fetched.
async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        allowNegative: true,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "V" },
            fetch: { type: "string", default: "http" },
            scope: { type: "string", default: "origin" },
            "max-pages": { type: "string", default: "0" },
            "max-depth": { type: "string", default: "0" },
            include: { type: "string", multiple: true, default: [] },
            exclude: { type: "string", multiple: true, default: [] },
            robots: { type: "boolean", default: true },
            fold: { type: "boolean", default: true },
            format: { type: "string", default: "human" },
            "fail-on": { type: "string", default: "error" },
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
    const format = FORMATTERS[values.format as keyof typeof FORMATTERS];
    const failOn = RANK[values["fail-on"] as FailOn];
    if (!format || failOn === undefined || seeds.length === 0 || !["audit", "facts", "groups"].includes(command ?? "")) {
        console.error(USAGE);
        return 2;
    }
    try {
        const report = await audit({
            seeds,
            fetch: values.fetch as FetchMode,
            scope: values.scope as Scope,
            maxPages: command === "facts" ? 1 : Number(values["max-pages"]),
            maxDepth: Number(values["max-depth"]),
            include: values.include,
            exclude: values.exclude,
            robots: values.robots,
            fold: values.fold ? { threshold: 0.8, min: 3 } : false,
            groups: command === "facts" ? { default: { rules: [] } } : {},
        });
        if (command === "facts") console.log(JSON.stringify(report.pages[0], undefined, 2));
        else if (command === "groups") console.log(groupsOf(report));
        else console.log(format(report));
        return command === "audit" ? exitCode(report, values["fail-on"] as FailOn) : report.pages.length === 0 ? 3 : 0;
    } catch (error) {
        log.error({ error: error instanceof Error ? error.message : String(error) }, "audit aborted");
        return 2;
    }
}

process.exitCode = await main(process.argv.slice(2));
