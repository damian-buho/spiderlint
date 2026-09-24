// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import type { Report } from "../index.ts";
import type { Finding } from "../rules/types.ts";
import { plain, type Paint, type Style } from "../color.ts";
import type { Grade, Rating } from "./rating.ts";

const ORDER = { error: 0, warning: 1, info: 2 };
const TONE: Record<Finding["severity"], Style> = { error: "red", warning: "yellow", info: "blue" };
const LIST = 5;
const DETAIL = " ".repeat(10);
const NESTED = " ".repeat(12);
const LABEL = 11;
const BYTE_UNITS: [number, string][] = [
    [1e9, "gigabyte"],
    [1e6, "megabyte"],
    [1e3, "kilobyte"],
    [1, "byte"],
];
const PLURAL: Record<string, string> = { error: "errors", warning: "warnings", info: "info", page: "pages", launch: "launches", fetch: "fetches", request: "requests" };
const ORANGE = "#ff8700";
const GRADE_TONE: Record<Grade, Style> = { S: "green", A: "green", B: "yellow", C: ORANGE, D: ORANGE, E: "red", F: "red" };

// The locale’s digits and decimal mark, groups split by a narrow no-break space as SI writes them.
function number(value: number, options: Intl.NumberFormatOptions = {}): string {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, ...options }).formatToParts(value).map((part) => (part.type === "group" ? "\u{202F}" : part.value)).join("");
}

// A count and its noun, plural unless it is exactly one.
function counted(count: number, noun: string): string {
    return `${number(count)} ${count === 1 ? noun : (PLURAL[noun] ?? noun)}`;
}

// Bytes in the largest unit they reach.
function size(bytes: number): string {
    const [scale, unit] = BYTE_UNITS.find(([floor]) => bytes >= floor) ?? [1, "byte"];
    return number(bytes / scale, { style: "unit", unit });
}

// One summary row: a padded label, then its value.
function row(label: string, value: string): string {
    return `${label.padEnd(LABEL)}${value}`;
}

// At most `limit` URLs on the detail line, the rest as a count.
function list(urls: string[], origin: string, limit: number): string {
    const shown = urls.slice(0, limit).map((url) => relative(url, origin)).join(", ");
    return urls.length > limit ? `${shown} … and ${urls.length - limit} more` : shown;
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
    const isShared = new Set(samples.map((url) => JSON.stringify(byPage?.[url] ?? []))).size === 1;
    return !byPage || isShared
        ? [paint("dim", `${DETAIL}e.g. ${list(samples, origin, limit)}`), ...located(byPage?.[samples[0] as string], NESTED, paint, limit)]
        : samples.flatMap((url) => [paint("dim", `${DETAIL}e.g. ${relative(url, origin)}`), ...located(byPage[url], NESTED, paint, limit)]);
}

function heading(finding: Finding, paint: Paint): string {
    return `  ${paint(TONE[finding.severity], finding.severity.padEnd(7))} ${paint("bold", finding.rule)}`;
}

function shortMessage(finding: Finding, origin: string): string {
    return origin ? finding.message.replaceAll(`${origin}/`, "/") : finding.message;
}

// Page findings sharing severity, rule and message bundle together; folds and aggregates stay alone.
function bundle(findings: Finding[]): Finding[][] {
    const bundles = new Map<string, Finding[]>();
    for (const [index, finding] of findings.entries()) {
        const isPlain = finding.occurrences === undefined && !finding.urls;
        const key = isPlain ? `${finding.severity}\t${finding.rule}\t${finding.message}` : String(index);
        bundles.set(key, [...(bundles.get(key) ?? []), finding]);
    }
    return bundles.values().toArray();
}

// A bundle prints its message once, then every page on its own line.
function bundled(same: Finding[], origin: string, paint: Paint, limit: number): string[] {
    const first = same[0] as Finding;
    return [`${heading(first, paint)} — ${same.length} pages: ${shortMessage(first, origin)}`, ...same.flatMap((finding) => [paint("dim", `          ${relative(finding.url, origin)}`), ...located(finding.locations, NESTED, paint, limit)])];
}

// A fold shows its samples; an aggregate its URL list, and its own URL when that is not one of them.
function line(finding: Finding, origin: string, paint: Paint, limit: number): string[] {
    const url = relative(finding.url, origin);
    const message = shortMessage(finding, origin);
    const head = heading(finding, paint);
    if (finding.occurrences !== undefined) {
        return [`${head} — ${finding.occurrences} pages (${Math.round((finding.coverage ?? 0) * 100)}%): ${message}`, ...sampled(finding, origin, paint, limit)];
    }
    if (!finding.urls) return [`${head} ${url}: ${message}`, ...located(finding.locations, DETAIL, paint, limit)];
    const subject = finding.urls.includes(finding.url) ? "—" : `${url}:`;
    return [`${head} ${subject} ${message}`, paint("dim", `          ${list(finding.urls, origin, limit)}`)];
}

// The grade and the rulesets it was earned under; a dash when nothing was judged.
function ratingValue(rating: Rating | undefined, paint: Paint): string {
    return rating ? `${paint(GRADE_TONE[rating.grade], paint("bold", rating.grade))} (${rating.rulesets.join(", ")})` : "– (no checks ran)";
}

// The shared origin once on top, the rating under it, findings grouped by group then rule, site-wide ones last, then the totals; `isFull` lists every URL and location.
export function formatHuman(report: Report, paint: Paint = plain, isFull = false): string {
    const limit = isFull ? Infinity : LIST;
    const origin = singleOrigin(report.pages.map((page) => page.url.href));
    const out: string[] = origin ? [paint(["bold", "underline"], origin)] : [];
    const groups = new Map<string, Finding[]>();
    for (const finding of report.findings) {
        const key = finding.scope === "site" ? "site" : (finding.group as string);
        groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
    for (const [group, findings] of groups) {
        const pages = report.summary.groups[group] ?? 0;
        out.push(group === "site" ? paint("bold", "site") : `${paint("bold", group)} ${paint("dim", `(${counted(pages, "page")})`)}`);
        findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url));
        for (const same of bundle(findings)) out.push(...(same.length > 1 ? bundled(same, origin, paint, limit) : line(same[0] as Finding, origin, paint, limit)));
    }
    out.push("", ...totals(report.summary, paint), ...costRows(report.summary.cost).map((line) => paint("dim", line)));
    return out.join("\n");
}

// Pages, size, time, rules, checks, findings and the rating, one row each; findings are counted before folding.
function totals({ pages, bytes, durationMs, statuses, rules, checks, findings, rating }: Report["summary"], paint: Paint): string[] {
    const answers = Object.entries(statuses).map(([status, count]) => `${number(count)} × ${status}`);
    const severities = (Object.keys(ORDER) as Finding["severity"][]).map((severity) => (findings[severity] > 0 ? paint(TONE[severity], counted(findings[severity], severity)) : counted(0, severity)));
    return [
        row("pages", `${number(pages)} (${answers.join(", ")})`),
        row("size", size(bytes)),
        row("time", number(durationMs / 1000, { style: "unit", unit: "second" })),
        row("rules", number(rules)),
        row("checks", `${number(checks.passed)} of ${number(checks.total)} passed`),
        row("findings", `${number(findings.total)} (${severities.join(", ")})`),
        row("rating", ratingValue(rating, paint)),
    ];
}

// Browsers launched and pages they rendered, plain HTTP fetches, resource requests and extractor runs, one row each.
function costRows({ browser, http, resources, extractors }: Report["summary"]["cost"]): string[] {
    const runs = Object.entries(extractors).map(([id, count]) => `${id} ×${number(count)}`);
    return [
        browser ? row("browser", `${browser.name}, ${counted(browser.pages, "page")} in ${counted(browser.launches, "launch")}`) : "",
        http ? row("http", `${counted(http.pages, "fetch")}${http.revalidated > 0 ? ` (${number(http.revalidated)} revalidated)` : ""}`) : "",
        browser || http ? "" : row("fetch", "none"),
        resources ? row("resources", `${counted(resources.requests, "request")}${resources.cached > 0 ? ` (${number(resources.cached)} more from cache)` : ""}`) : "",
        runs.length > 0 ? row("extractors", runs.join(", ")) : "",
    ].filter(Boolean);
}
