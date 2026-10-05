// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import { environmentLocale } from "../i18n.ts";
import { bytes as sized, isLabelled, label, withUnit } from "../facts/labels.ts";
import type { Report } from "../index.ts";
import { fixFor } from "../rules/fix.ts";
import { cachedReads, valuesAt } from "../rules/message.ts";
import { byImportance, scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";
import { plain, type Paint, type Style } from "../color.ts";
import { printable, printableFinding } from "./printable.ts";
import { passing, type Grade, type Rating } from "./rating.ts";

const ORDER = { error: 0, warning: 1, info: 2, hint: 3 };
const TONE: Record<Finding["severity"], Style> = { error: "red", warning: "yellow", info: "blue", hint: "dim" };
const LIST = 5;
const DETAIL = " ".repeat(10);
const NESTED = " ".repeat(12);
const LABEL = 11;
const PLURAL: Record<string, string> = { rule: "rules", error: "errors", warning: "warnings", info: "info", hint: "hints", page: "pages", launch: "launches", fetch: "fetches", request: "requests", "TLS probe": "TLS probes", "cached read": "cached reads" };
const ORANGE = "#ff8700";
const GRADE_TONE: Record<Grade, Style> = { S: "green", A: "green", B: "yellow", C: ORANGE, D: ORANGE, E: "red", F: "red" };
const MINUS = "\u{2212}";

// The locale’s digits and decimal mark, groups split by a narrow no-break space as SI writes them.
function number(value: number, options: Intl.NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(environmentLocale(), { maximumFractionDigits: 1, ...options })
        .formatToParts(value)
        .map((part) => (part.type === "group" ? "\u{202F}" : part.value))
        .join("");
}

// A count and its noun, plural unless it is exactly one.
function counted(count: number, noun: string): string {
    return `${number(count)} ${count === 1 ? noun : (PLURAL[noun] ?? noun)}`;
}

// One summary row: a padded label, then its value.
function row(label: string, value: string): string {
    return `${label.padEnd(LABEL)}${value}`;
}

// At most `limit` URLs on the detail line, the rest as a count.
function list(urls: string[], origin: string, limit: number): string {
    const shown = urls
        .slice(0, limit)
        .map((url) => relative(url, origin))
        .join(", ");
    return urls.length > limit ? `${shown} … and ${urls.length - limit} more` : shown;
}

// A URL, then what was measured there, each relative to the origin.
function shown(finding: Finding, url: string, origin: string): string {
    return [url, ...valuesAt(finding, url, number)].map((text) => relative(text, origin)).join("  ");
}

// At most `limit` URLs one per line with their values, the rest as a count.
function measured(finding: Finding, urls: string[], indent: string, origin: string, paint: Paint, limit: number): string[] {
    const lines = urls.slice(0, limit).map((url) => paint("dim", `${indent}${shown(finding, url, origin)}`));
    return urls.length > limit ? [...lines, paint("dim", `${indent}… and ${urls.length - limit} more`)] : lines;
}

// At most `limit` locations, each on its own line under what it locates, the rest as a count.
function located(locations: string[] | undefined, indent: string, paint: Paint, limit: number): string[] {
    if (!locations || locations.length === 0) return [];
    const shown = locations.slice(0, limit).map((location) => paint("dim", `${indent}at ${location}`));
    return locations.length > limit ? [...shown, paint("dim", `${indent}… and ${locations.length - limit} more`)] : shown;
}

// A fold’s samples; pages whose locations all match share one list under the URLs.
function sampled(finding: Finding, origin: string, paint: Paint, limit: number): string[] {
    const samples = finding.samples ?? [];
    const byPage = finding.sampleLocations;
    const isShared = !finding.data && new Set(samples.map((url) => JSON.stringify(byPage?.[url] ?? []))).size === 1;
    return isShared ? [paint("dim", `${DETAIL}e.g. ${list(samples, origin, limit)}`), ...located(byPage?.[samples[0] as string], NESTED, paint, limit)] : samples.flatMap((url) => [paint("dim", `${DETAIL}e.g. ${shown(finding, url, origin)}`), ...located(byPage?.[url], NESTED, paint, limit)]);
}

function heading(finding: Finding, paint: Paint): string {
    return `  ${paint(TONE[finding.severity], `${finding.severity.padEnd(7)} ${scoreOf(finding).toFixed(1)}`)} ${paint("bold", finding.rule)}`;
}

function shortMessage(finding: Finding, origin: string): string {
    return origin ? finding.message.replaceAll(`${origin}/`, "/") : finding.message;
}

// Page findings sharing severity, score, rule and sentence bundle together, by template when they carry one; folds and aggregates stay alone.
export function bundle(findings: Finding[]): Finding[][] {
    const bundles = new Map<string, Finding[]>();
    for (const [index, finding] of findings.entries()) {
        const isPlain = finding.occurrences === undefined && !finding.urls;
        const key = isPlain ? `${finding.severity}\t${scoreOf(finding)}\t${finding.rule}\t${finding.text === undefined ? finding.message : `${finding.text}\t${JSON.stringify(finding.variables ?? {})}`}` : String(index);
        bundles.set(key, [...(bundles.get(key) ?? []), finding]);
    }
    return bundles.values().toArray();
}

// A bundle prints its message once, then every page on its own line.
function bundled(same: Finding[], origin: string, paint: Paint, limit: number): string[] {
    const first = same[0] as Finding;
    return [`${heading(first, paint)} — ${same.length} pages: ${shortMessage(first, origin)}`, ...same.flatMap((finding) => [paint("dim", `${DETAIL}${shown(finding, finding.url, origin)}`), ...located(finding.locations, NESTED, paint, limit)])];
}

// A fold shows its samples; an aggregate its URL list, and its own URL when that is not one of them.
function line(finding: Finding, origin: string, paint: Paint, limit: number): string[] {
    const url = relative(finding.url, origin);
    const message = shortMessage(finding, origin);
    const head = heading(finding, paint);
    if (finding.occurrences !== undefined) {
        const pages = finding.sampled === undefined ? `${finding.occurrences} pages` : `${finding.occurrences} of ${finding.sampled} sampled pages`;
        return [`${head} — ${pages} (${Math.round((finding.coverage ?? 0) * 100)}%): ${message}`, ...sampled(finding, origin, paint, limit)];
    }
    if (!finding.urls) return [`${head} ${url}: ${message}`, ...measured(finding, Object.hasOwn(finding.data ?? {}, finding.url) ? [finding.url] : [], DETAIL, origin, paint, limit), ...located(finding.locations, DETAIL, paint, limit)];
    const subject = finding.urls.includes(finding.url) ? "—" : `${url}:`;
    const urls = finding.data ? measured(finding, finding.urls, DETAIL, origin, paint, limit) : [paint("dim", `${DETAIL}${list(finding.urls, origin, limit)}`)];
    return [`${head} ${subject} ${message}`, ...urls, ...located(finding.locations, DETAIL, paint, limit)];
}

// The grade and the rulesets it was earned under; a dash when nothing was judged.
function ratingValue(rating: Rating | undefined, paint: Paint): string {
    return rating ? `${paint(GRADE_TONE[rating.grade], paint("bold", rating.grade))} (${rating.rulesets.join(", ")})` : "– (no checks ran)";
}

// A signed change against the last run, green when it fell and red when it grew; nothing when equal or unknown.
function change(now: number, before: number | undefined, paint: Paint): string {
    return before === undefined || now === before ? "" : ` ${paint(now < before ? "green" : "red", `${now < before ? MINUS : "+"}${number(Math.abs(now - before))}`)}`;
}

// The rule’s fix filled for this finding, then its docs, under the finding.
function explanation(guide: RuleGuide | undefined, finding: Finding, paint: Paint): string[] {
    return [guide?.fix ? `${paint("dim", `${DETAIL}fix  `)}${fixFor(guide.fix, finding)}` : "", guide?.docs ? paint("dim", `${DETAIL}docs ${guide.docs}`) : ""].filter(Boolean);
}

// Findings by importance (score times the share of pages touched) then rule then URL, bundled, each followed by its explanation when `guides` is given.
function listed(findings: Finding[], origin: string, paint: Paint, limit: number, total: number, guides?: Report["rules"]): string[] {
    findings.sort(byImportance(total));
    return bundle(findings).flatMap((same) => {
        const first = same[0] as Finding;
        return [...(same.length > 1 ? bundled(same, origin, paint, limit) : line(first, origin, paint, limit)), ...(guides ? explanation(guides[first.rule], first, paint) : [])];
    });
}

// The shared origin once on top, findings grouped by group then rule, site-wide ones next, then each vendor’s, hints last and only counted unless `isHintListed`, the fact statistics with `isStats`, then the totals; `isFull` lists every URL and location, `isExplained` each fix.
export function formatHuman(report: Report, paint: Paint = plain, isFull = false, _lang?: string, isHintListed = false, isExplained = false, isStats = false): string {
    const limit = isFull ? Infinity : LIST;
    const guides = isExplained ? (report.rules ?? {}) : undefined;
    const origin = singleOrigin(report.pages.map((page) => page.url.href));
    const out: string[] = origin ? [paint(["bold", "underline"], origin)] : [];
    const groups = new Map<string, Finding[]>();
    const vendors = new Map<string, Finding[]>();
    const findings = report.findings.map((finding) => printableFinding(finding));
    const hints = findings.filter((finding) => finding.severity === "hint");
    for (const finding of findings) {
        if (finding.severity === "hint") continue;
        const [sections, key] = finding.vendor ? [vendors, finding.vendor] : [groups, finding.scope === "site" ? "site" : (finding.group as string)];
        sections.set(key, [...(sections.get(key) ?? []), finding]);
    }
    for (const [group, findings] of groups) {
        const pages = report.summary.groups[group] ?? 0;
        out.push(group === "site" ? paint("bold", "site") : `${paint("bold", group)} ${paint("dim", `(${counted(pages, "page")})`)}`, ...listed(findings, origin, paint, limit, report.pages.length, guides));
    }
    for (const [vendor, findings] of vendors) out.push(`${paint("bold", vendor)} ${paint("dim", "(vendor)")}`, ...listed(findings, origin, paint, limit, report.pages.length, guides));
    if (hints.length > 0) out.push(`${paint("bold", "hints")} ${paint("dim", `(${counted(hints.length, "hint")})`)}`, ...(isHintListed ? listed(hints, origin, paint, limit, report.pages.length, guides) : [paint("dim", `${DETAIL}--show-hints lists them`)]));
    out.push(...cachedRow(findings, paint));
    if (isFull) out.push("", ...passedRows(report.summary, paint));
    if (isStats) out.push("", ...statRows(report.summary.stats ?? {}, paint));
    out.push("", ...totals(report.summary, paint), ...costRows(report.summary.cost).map((line) => paint("dim", line)));
    return out.join("\n");
}

// How many observations behind the findings came from a cache, by bucket, and how to read them again; nothing when none did.
function cachedRow(findings: Finding[], paint: Paint): string[] {
    const reads = cachedReads(findings);
    if (reads.length === 0) return [];
    const buckets = [...new Set(reads.map((read) => read.bucket))].join(", ");
    return ["", paint("dim", `${counted(reads.length, "cached read")} behind these findings (${buckets}); --refresh reads them again`)];
}

// Every rule that failed nowhere with the pages it covered, under a count; nothing when none ran.
function passedRows({ checked }: Report["summary"], paint: Paint): string[] {
    const rules = passing(checked);
    return rules.length === 0 ? [] : [paint("bold", `passed ${counted(rules.length, "rule")}`), ...rules.map(([id, rule]) => `  ${paint("green", "✓")} ${id} ${paint("dim", counted(rule.pages, "page"))}`)];
}

// Pages, size, time, rules, checks, findings with their change since the last run, and the rating, one row each; findings are counted before folding.
function totals({ pages, bytes, durationMs, statuses, rules, checks, findings, rating, previous }: Report["summary"], paint: Paint): string[] {
    const answers = Object.entries(statuses).map(([status, count]) => `${number(count)} × ${status}`);
    const shown = (Object.keys(ORDER) as Finding["severity"][]).filter((severity) => severity !== "hint" || (findings.hint ?? 0) > 0);
    const severities = shown.map((severity) => `${(findings[severity] ?? 0) > 0 ? paint(TONE[severity], counted(findings[severity], severity)) : counted(0, severity)}${change(findings[severity], previous?.findings[severity], paint)}`);
    const since = previous ? paint("dim", ` since ${new Date(previous.started).toLocaleString(environmentLocale(), { dateStyle: "short", timeStyle: "short" })}`) : "";
    return [
        row("pages", answers.length > 0 ? `${number(pages)} (${answers.join(", ")})` : number(pages)),
        row("size", sized(bytes, number)),
        row("time", number(durationMs / 1000, { style: "unit", unit: "second" })),
        row("rules", number(rules)),
        row("checks", `${number(checks.passed)} of ${number(checks.total)} passed`),
        row("findings", `${number(findings.total)}${change(findings.total, previous?.findings.total, paint)} (${severities.join(", ")})${since}`),
        row("rating", ratingValue(rating, paint)),
    ];
}

// A measured value in the unit `path` carries, if any.
export function measure(value: number, path = ""): string {
    return withUnit(path, value, number);
}

// Rows as aligned columns, the first padded at its end and the rest at their start, the header bold.
export function aligned(rows: string[][], paint: Paint): string[] {
    const widths = (rows[0] as string[]).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
    const lines = rows.map((row) =>
        row
            .map((cell, column) => (column === 0 ? cell.padEnd(widths[0] as number) : cell.padStart(widths[column] as number)))
            .join("  ")
            .trimEnd(),
    );
    return [paint("bold", lines[0] as string), ...lines.slice(1)];
}

// One aligned row per labelled numeric fact by its label: pages, then min, median, p95, max and total in its unit, under a header.
export function statRows(stats: NonNullable<Report["summary"]["stats"]>, paint: Paint): string[] {
    const cells = Object.entries(stats)
        .filter(([path]) => isLabelled(path))
        .map(([path, stat]) => [printable(label(path) ?? path), measure(stat.count), ...[stat.min, stat.median, stat.p95, stat.max, stat.total].map((value) => (value === undefined ? "–" : measure(value, path)))]);
    return cells.length === 0 ? [row("stats", "none")] : aligned([["stats", "pages", "min", "median", "p95", "max", "total"], ...cells], paint);
}

// Browsers launched and pages they rendered, plain HTTP fetches, resource requests, extractor runs and cache hits, one row each.
function costRows({ browser, http, resources, extractors, extractorsCached = {} }: Report["summary"]["cost"]): string[] {
    const runs = Object.entries(extractors).map(([id, count]) => `${id} ×${number(count)}`);
    const hits = Object.entries(extractorsCached).map(([id, count]) => `${id} ×${number(count)}`);
    return [
        browser ? row("browser", `${browser.name}, ${counted(browser.pages, "page")} in ${counted(browser.launches, "launch")}${browser.tlsProbes > 0 ? `, ${counted(browser.tlsProbes, "TLS probe")}` : ""}`) : "",
        http ? row("http", `${counted(http.pages, "fetch")}${http.revalidated > 0 ? ` (${number(http.revalidated)} revalidated)` : ""}`) : "",
        browser || http ? "" : row("fetch", "none"),
        resources
            ? row(
                  "resources",
                  `${counted(resources.requests, "request")}${resources.cached > 0 ? ` (${number(resources.cached)} more from cache${resources.failuresCached ? `, ${counted(resources.failuresCached, "failure")}` : ""})` : ""}${resources.logged > 0 ? ` (${number(resources.logged)} more from the browser)` : ""}`,
              )
            : "",
        runs.length > 0 ? row("extractors", runs.join(", ")) : "",
        hits.length > 0 ? row("cached", hits.join(", ")) : "",
    ].filter(Boolean);
}
