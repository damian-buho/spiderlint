// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "../cache/index.ts";
import { relative, singleOrigin } from "../crawl/scope.ts";
import type { Report } from "../index.ts";
import { isRanked } from "../facts/flatten.ts";
import { log } from "../logger.ts";
import { fixFor } from "../rules/fix.ts";
import { cachedReads, inEnglish, valuesAt } from "../rules/message.ts";
import { utc } from "../facts/read-note.ts";
import { importance, scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";
import { bundle } from "./human.ts";
import { passing } from "./rating.ts";
import { printable, printableFinding } from "./printable.ts";

// Pages a fix clears: a fold’s occurrences, an aggregate’s URLs, else the one page.
function clears(finding: Finding): number {
    return finding.occurrences ?? finding.urls?.length ?? 1;
}

// The origin to re-audit for a finding: the audited one, else its URL’s, else the host it names.
function originOf(finding: Finding, shared: string): string {
    return shared || (URL.canParse(finding.url) ? new URL(finding.url).origin : `https://${finding.url}`);
}

// Findings grouped by rule, rules by their most important finding (score times the share of pages touched) then the pages they clear, findings within a rule by the same.
export function ordered(findings: Finding[], pages: number): Finding[][] {
    const byRule = new Map<string, Finding[]>();
    for (const finding of findings) byRule.set(finding.rule, [...(byRule.get(finding.rule) ?? []), finding]);
    const total = (same: Finding[]) => same.reduce((sum, finding) => sum + clears(finding), 0);
    const top = (same: Finding[]) => Math.max(...same.map((finding) => importance(finding, pages)));
    const rules = byRule
        .values()
        .map((same) => same.toSorted((a, b) => importance(b, pages) - importance(a, pages) || clears(b) - clears(a) || a.url.localeCompare(b.url)))
        .toArray();
    return rules.toSorted((a, b) => top(b) - top(a) || total(b) - total(a) || (a[0] as Finding).rule.localeCompare((b[0] as Finding).rule));
}

// Where a finding sits: a fold’s samples, an aggregate’s URLs, or its pages, each with its values and locations.
function where(same: Finding[], origin: string): string[] {
    const finding = same[0] as Finding;
    const named = (url: string, owner: Finding) => [relative(url, origin), ...valuesAt(owner, url, inEnglish).map((value) => relative(value, origin))].join(": ");
    const at = (url: string, locations: string[] | undefined, owner = finding) => [`- ${named(url, owner)}`, ...(locations ?? []).map((location) => `  - at ${location}`)];
    if (finding.occurrences !== undefined) {
        const pages = finding.sampled === undefined ? `${finding.occurrences} pages` : `${finding.occurrences} of ${finding.sampled} sampled pages`;
        return [`Where: ${pages} of group ${finding.group} (${Math.round((finding.coverage ?? 0) * 100)} %), for example:`, ...(finding.samples ?? []).flatMap((url) => at(url, finding.sampleLocations?.[url]))];
    }
    if (finding.urls) return [`Where: ${named(finding.url, finding)}, used by or shared with:`, ...finding.urls.flatMap((url) => at(url, undefined)), ...(finding.locations ?? []).map((location) => `- at ${location}`)];
    return same.length > 1 ? [`Where: ${same.length} pages:`, ...same.flatMap((page) => at(page.url, page.locations, page))] : [`Where: ${named(finding.url, finding)}`, ...(finding.locations ?? []).map((location) => `- at ${location}`)];
}

// The reads a bundle took from a cache, so the agent knows a fix may already be live.
function cached(same: Finding[], origin: string): string[] {
    const reads = cachedReads(same);
    return reads.length === 0 ? [] : ["From the cache (`--refresh` reads them again):", ...reads.map((read) => `- ${relative(read.key, origin) || read.key}${read.at ? `, read ${utc(read.at)}` : ""}`)];
}

// One self-contained task over findings sharing rule and message: rule and severity, message, place, what the rule reads and expects, the fix and how to prove it.
function block(same: Finding[], guide: RuleGuide | undefined, origin: string): string {
    const finding = same[0] as Finding;
    const target = originOf(finding, origin);
    const reads = guide?.facts.length ? `Reads: ${guide.facts.map((fact) => `\`${fact}\``).join(", ")}${guide.expect ? `, expects \`${JSON.stringify(guide.expect)}\`` : ""}` : "";
    const facts = finding.scope === "page" && guide?.expect ? `, and \`spiderlint show-facts ${finding.samples?.[0] ?? finding.url}\` shows \`${guide.facts[0]}\` meeting it` : "";
    const fix = guide?.fix ? `Fix: ${fixFor(guide.fix, finding)}` : guide?.docs ? `Fix: follow ${guide.docs}` : "";
    return [
        `## ${finding.rule} (${finding.severity} ${scoreOf(finding).toFixed(1)})`,
        "",
        origin ? finding.message.replaceAll(`${origin}/`, "/") : finding.message,
        "",
        ...where(same, origin),
        ...cached(same, origin),
        ...[reads, fix, guide?.fix && guide.docs ? `Docs: ${guide.docs}` : ""].filter(Boolean),
        `Done when: \`spiderlint audit ${target}/ --rules ${finding.rule}\` reports no ${finding.rule} finding${facts}.`,
    ].join("\n");
}

// The origin every finding shares, from the pages, else from the findings when the report was stored without them.
function sharedOrigin(report: Report): string {
    return singleOrigin(report.pages.length > 0 ? report.pages.map((page) => page.url.href) : report.findings.map((finding) => finding.url));
}

// Findings a coding agent acts on: hints only when listed.
function actionable(report: Report, isHintListed: boolean): Finding[] {
    const findings = report.findings.filter((finding) => isHintListed || finding.severity !== "hint").map((finding) => printableFinding(finding));
    log.debug({ findings: findings.length, hints: report.findings.length - findings.length, isHintListed }, "agent findings chosen");
    return findings;
}

// CO2, bytes, requests and timings as one Markdown table, so an agent weighs a fix against the site; nothing without statistics.
function statistics(stats: Report["summary"]["stats"] = {}): string[] {
    const rows = Object.entries(stats)
        .filter(([path]) => isRanked(path))
        .map(([path, stat]) => `| \`${printable(path).replaceAll("|", String.raw`\|`)}\` | ${[stat.count, stat.min, stat.median, stat.p95, stat.max, stat.total ?? "–"].join(" | ")} |`);
    return rows.length === 0 ? [] : [["# Site statistics", "", "| Fact | Pages | Min | Median | p95 | Max | Total |", "| --- | --: | --: | --: | --: | --: | --: |", ...rows].join("\n")];
}

// How many checks and rules came out clean, as one line; the list stays in `json`.
function passed({ checks, checked }: Report["summary"]): string[] {
    return [`Checks passed: ${checks.passed} of ${checks.total}; ${passing(checked).length} rules failed nowhere.`];
}

// One block per finding after folding, no colour, then the fact statistics; the shared origin once on top and URLs under it relative.
export function formatAgent(report: Report, _paint?: unknown, _isFull?: boolean, _lang?: string, isHintListed = false): string {
    const origin = sharedOrigin(report);
    const blocks = ordered(actionable(report, isHintListed), report.pages.length).flatMap((rule) => bundle(rule).map((same) => block(same, report.rules?.[(same[0] as Finding).rule], origin)));
    return [`# spiderlint findings${origin ? ` for ${origin}` : ""}`, ...(blocks.length > 0 ? blocks : ["No findings."]), ...passed(report.summary), ...statistics(report.summary.stats)].join("\n\n");
}

// One Markdown prompt per rule, by file name, the same findings always giving the same bytes.
export function agentFiles(report: Report, isHintListed = false): Map<string, string> {
    const origin = sharedOrigin(report);
    const files = new Map<string, string>();
    const rules = ordered(actionable(report, isHintListed), report.pages.length);
    for (const same of rules) {
        const rule = (same[0] as Finding).rule;
        const title = `# spiderlint: ${rule}${origin ? ` on ${origin}` : ""}`;
        files.set(`${rule.replaceAll(/[^a-z0-9.-]+/gi, "-")}.md`, `${[title, ...bundle(same).map((bundled) => block(bundled, report.rules?.[rule], origin))].join("\n\n")}\n`);
    }
    log.debug({ files: files.size }, "agent files rendered");
    return files;
}

// Writes each rule’s prompt into `directory`, atomically, so a reader never sees half a file.
export async function writeAgentFiles(directory: string, report: Report, isHintListed = false): Promise<void> {
    await mkdir(directory, { recursive: true });
    const files = agentFiles(report, isHintListed);
    const entries = [...files];
    for (const [name, content] of entries) await writeAtomic(path.join(directory, name), content);
    log.info({ directory, files: files.size }, `${files.size} agent prompts written to ${directory}`);
}
