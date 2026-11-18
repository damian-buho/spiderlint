// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { rulePageUrl } from "../rules/book.ts";
import { relative, singleOrigin } from "../crawl/scope.ts";
import { environmentLocale } from "../i18n.ts";
import { bytes as sized, glued, isLabelled, label, withUnit, type NumberFormat } from "../facts/labels.ts";
import type { Report } from "../index.ts";
import { fixFor, fixesOf, plainFix } from "../rules/fix.ts";
import { cachedReads, namedAt } from "../rules/message.ts";
import { byUrgency, scoreOf, type Sort } from "../rules/score.ts";
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
function numberIn(locale = environmentLocale()): NumberFormat {
    return (value, options = {}) =>
        new Intl.NumberFormat(locale, { maximumFractionDigits: 1, ...options })
            .formatToParts(value)
            .map((part) => (part.type === "group" ? "\u{202F}" : part.value))
            .join("");
}

// A number in the process locale, read on each call.
const number: NumberFormat = (value, options) => numberIn()(value, options);

// A count and its noun, plural unless it is exactly one.
function counted(count: number, noun: string, number: NumberFormat): string {
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

// A URL, then what was measured there by name, each relative to the origin.
function shown(finding: Finding, url: string, origin: string): string {
    return [relative(url, origin), ...namedAt(finding, url, number, (text) => relative(text, origin))].join("  ");
}

// At most `limit` URLs one per line with their values at `indent`, the rest as a count.
function measured(finding: Finding, urls: string[], origin: string, paint: Paint, limit: number, indent = DETAIL): string[] {
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

// Page findings sharing severity, score, rule and sentence bundle together, by template when they carry one; folds stay alone, aggregates too unless `isMerged`.
export function bundle(findings: Finding[], isMerged = false): Finding[][] {
    const bundles = new Map<string, Finding[]>();
    for (const [index, finding] of findings.entries()) {
        const isPlain = finding.occurrences === undefined && (isMerged || !finding.urls);
        const key = isPlain ? `${finding.severity}\t${scoreOf(finding)}\t${finding.rule}\t${finding.text === undefined ? finding.message : `${finding.text}\t${JSON.stringify(finding.variables ?? {})}`}` : String(index);
        bundles.set(key, [...(bundles.get(key) ?? []), finding]);
    }
    return bundles.values().toArray();
}

// A merged bundle’s findings grouped by the page list they share, so the pages print once.
export function byPages(same: Finding[]): Finding[][] {
    return Map.groupBy(same, (finding) => JSON.stringify(finding.urls))
        .values()
        .toArray();
}

// A bundle prints its message once, then every page on its own line.
function bundled(same: Finding[], origin: string, paint: Paint, limit: number): string[] {
    const first = same[0] as Finding;
    if (first.urls)
        return [
            `${heading(first, paint)} — ${same.length} findings: ${shortMessage(first, origin)}`,
            ...byPages(same).flatMap((group) => [
                ...group.map((finding) => paint("dim", `${DETAIL}${shown(finding, finding.url, origin)}`)),
                ...(group[0]?.urls ?? []).slice(0, limit).map((url) => paint("dim", `${NESTED}${relative(url, origin)}`)),
                ...((group[0]?.urls?.length ?? 0) > limit ? [paint("dim", `${NESTED}… and ${(group[0]?.urls?.length ?? 0) - limit} more`)] : []),
            ]),
        ];
    return [`${heading(first, paint)} — ${same.length} pages: ${shortMessage(first, origin)}`, ...same.flatMap((finding) => [paint("dim", `${DETAIL}${shown(finding, finding.url, origin)}`), ...located(finding.locations, NESTED, paint, limit)])];
}

// A fold shows its samples; a finding its URL under the message; an aggregate its URL list, nested under its own URL when that is not one of them.
function line(finding: Finding, origin: string, paint: Paint, limit: number): string[] {
    const message = shortMessage(finding, origin);
    const head = heading(finding, paint);
    if (finding.occurrences !== undefined) {
        const pages = `${finding.sampled === undefined ? `${finding.occurrences} pages` : `${finding.occurrences} of ${finding.sampled} sampled pages`}${finding.groups ? ` in ${finding.groups.join(", ")}` : ""}`;
        return [`${head} — ${pages} (${Math.round((finding.coverage ?? 0) * 100)}%): ${message}`, ...sampled(finding, origin, paint, limit)];
    }
    const subject = [paint("dim", `${DETAIL}${shown(finding, finding.url, origin)}`)];
    if (!finding.urls) return [`${head} — ${message}`, ...subject, ...located(finding.locations, NESTED, paint, limit)];
    const isOwn = finding.urls.includes(finding.url);
    const indent = isOwn ? DETAIL : NESTED;
    const urls = finding.data ? measured(finding, finding.urls, origin, paint, limit, indent) : [paint("dim", `${indent}${list(finding.urls, origin, limit)}`)];
    return [`${head} — ${message}`, ...(isOwn ? [] : subject), ...urls, ...located(finding.locations, DETAIL, paint, limit)];
}

// The grade and the rulesets it was earned under; a dash when nothing was judged.
function ratingValue(rating: Rating | undefined, paint: Paint): string {
    return rating ? `${paint(GRADE_TONE[rating.grade], paint("bold", rating.grade))} (${rating.rulesets.join(", ")})` : "– (no checks ran)";
}

// A signed change against the last run, green when it fell and red when it grew; nothing when equal or unknown.
function change(now: number, before: number | undefined, paint: Paint, number: NumberFormat): string {
    return before === undefined || now === before ? "" : ` ${paint(now < before ? "green" : "red", `${now < before ? MINUS : "+"}${number(Math.abs(now - before))}`)}`;
}

// The rule’s fixes filled for this finding, then its book page and reference, under the finding.
function explanation(guide: RuleGuide | undefined, finding: Finding, paint: Paint, lang = "en"): string[] {
    const all = fixesOf(guide);
    const fixes = all.map((fix, index) => {
        const head = `${DETAIL}fix${all.length > 1 ? ` ${index + 1}` : " "} `;
        return plainFix(fixFor(fix, finding))
            .map((line, number) => (number === 0 ? `${paint("dim", head)}${line}` : `${" ".repeat(head.length)}${line}`))
            .join("\n");
    });
    const page = rulePageUrl(finding.rule, lang);
    return [...fixes, page ? paint("dim", `${DETAIL}docs ${page}`) : "", guide?.docs ? paint("dim", `${DETAIL}ref  ${guide.docs}`) : ""].filter(Boolean);
}

// Findings by level then impact (score times pages touched), or by impact alone with `sort`, then rule then URL, bundled, each followed by its explanation when `guides` is given.
function listed(findings: Finding[], origin: string, paint: Paint, limit: number, total: number, sort: Sort, guides?: Report["rules"], lang?: string): string[] {
    findings.sort(byUrgency(total, sort));
    return bundle(findings, true).flatMap((same) => {
        const first = same[0] as Finding;
        return [...(same.length > 1 ? bundled(same, origin, paint, limit) : line(first, origin, paint, limit)), ...(guides ? explanation(guides[first.rule], first, paint, lang) : [])];
    });
}

// The shared origin once on top, then the totals with the rating and the fact statistics with `isStats`, then findings grouped by group, site-wide ones first, then each vendor’s, hints last and only counted unless `isHintListed`; `isFull` lists every URL and location, `isExplained` each fix, `sort` the order within a section; numbers in `lang`, the process locale unless named.
export function formatHuman(report: Report, paint: Paint = plain, isFull = false, lang?: string, isHintListed = false, isExplained = false, isStats = false, sort: Sort = "severity"): string {
    const locale = lang ?? environmentLocale();
    const number = numberIn(locale);
    const limit = isFull ? Infinity : LIST;
    const guides = isExplained ? (report.rules ?? {}) : undefined;
    const origin = singleOrigin(report.pages.map((page) => page.url.href));
    const out: string[] = origin ? [paint(["bold", "underline"], origin)] : [];
    out.push(...totals(report.summary, paint, number, locale), ...costRows(report.summary.cost, number).map((line) => paint("dim", line)), ...(isStats ? ["", ...statRows(report.summary.stats ?? {}, paint)] : []), "");
    const groups = new Map<string, Finding[]>();
    const vendors = new Map<string, Finding[]>();
    const findings = report.findings.map((finding) => printableFinding(finding));
    const hints = findings.filter((finding) => finding.severity === "hint");
    for (const finding of findings) {
        if (finding.severity === "hint") continue;
        const [sections, key] = finding.vendor ? [vendors, finding.vendor] : [groups, finding.scope === "site" ? "site" : (finding.group as string)];
        sections.set(key, [...(sections.get(key) ?? []), finding]);
    }
    const isOnlyDefault = groups.keys().every((group) => group === "site" || group === "default") && Object.keys(report.summary.groups).length <= 1;
    for (const [group, findings] of groups) {
        const pages = report.summary.groups[group] ?? 0;
        out.push(
            group === "site" ? `${paint("bold", "** whole site **")} ${paint("dim", "(every page)")}` : `${paint("bold", isOnlyDefault ? "pages" : `pages in group ${group}`)} ${paint("dim", `(${isOnlyDefault ? number(pages) : counted(pages, "page", number)})`)}`,
            ...listed(findings, origin, paint, limit, report.pages.length, sort, guides, lang),
        );
    }
    for (const [vendor, findings] of vendors) out.push(`${paint("bold", vendor)} ${paint("dim", "(vendor)")}`, ...listed(findings, origin, paint, limit, report.pages.length, sort, guides, lang));
    if (hints.length > 0) out.push(`${paint("bold", "hints")} ${paint("dim", `(${counted(hints.length, "hint", number)})`)}`, ...(isHintListed ? listed(hints, origin, paint, limit, report.pages.length, sort, guides, lang) : [paint("dim", `${DETAIL}--show-hints lists them`)]));
    out.push(...cachedRow(findings, paint, number));
    if (isFull) out.push("", ...passedRows(report.summary, paint, number));
    return out.join("\n").trimEnd();
}

// How many observations behind the findings came from a cache, by bucket, and how to read them again; nothing when none did.
function cachedRow(findings: Finding[], paint: Paint, number: NumberFormat): string[] {
    const reads = cachedReads(findings);
    if (reads.length === 0) return [];
    const buckets = [...new Set(reads.map((read) => read.bucket))].join(", ");
    return ["", paint("dim", `${counted(reads.length, "cached read", number)} behind these findings (${buckets}); --refresh reads them again`)];
}

// Every rule that failed nowhere with the pages it covered, under a count; nothing when none ran.
function passedRows({ checked }: Report["summary"], paint: Paint, number: NumberFormat): string[] {
    const rules = passing(checked);
    return rules.length === 0 ? [] : [paint("bold", `passed ${counted(rules.length, "rule", number)}`), ...rules.map(([id, rule]) => `  ${paint("green", "✓")} ${id} ${paint("dim", counted(rule.pages, "page", number))}`)];
}

// Pages, size, time, rules, checks, findings with their change since the last run, and the rating, one row each; findings are counted before folding.
function totals({ pages, bytes, durationMs, statuses, rules, checks, findings, rating, previous }: Report["summary"], paint: Paint, number: NumberFormat, locale: string | undefined): string[] {
    const answers = Object.entries(statuses).map(([status, count]) => `${number(count)} × ${status}`);
    const shown = (Object.keys(ORDER) as Finding["severity"][]).filter((severity) => severity !== "hint" || (findings.hint ?? 0) > 0);
    const severities = shown.map((severity) => `${(findings[severity] ?? 0) > 0 ? paint(TONE[severity], counted(findings[severity], severity, number)) : counted(0, severity, number)}${change(findings[severity], previous?.findings[severity], paint, number)}`);
    const since = previous ? paint("dim", ` since ${new Date(previous.started).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}`) : "";
    return [
        row("pages", answers.length > 0 ? `${number(pages)} (${answers.join(", ")})` : number(pages)),
        row("size", sized(bytes, number)),
        row("time", glued(number(durationMs / 1000, { style: "unit", unit: "second" }))),
        row("rules", number(rules)),
        row("checks", `${number(checks.passed)} of ${number(checks.total)} passed`),
        row("findings", `${number(findings.total)}${change(findings.total, previous?.findings.total, paint, number)} (${severities.join(", ")})${since}`),
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
function costRows({ browser, http, resources, extractors, extractorsCached = {} }: Report["summary"]["cost"], number: NumberFormat): string[] {
    const runs = Object.entries(extractors).map(([id, count]) => `${id} ×${number(count)}`);
    const hits = Object.entries(extractorsCached).map(([id, count]) => `${id} ×${number(count)}`);
    return [
        browser ? row("browser", `${browser.name}, ${counted(browser.pages, "page", number)} in ${counted(browser.launches, "launch", number)}${browser.tlsProbes > 0 ? `, ${counted(browser.tlsProbes, "TLS probe", number)}` : ""}`) : "",
        http ? row("http", `${counted(http.pages, "fetch", number)}${http.revalidated > 0 ? ` (${number(http.revalidated)} revalidated)` : ""}`) : "",
        browser || http ? "" : row("fetch", "none"),
        resources
            ? row(
                  "resources",
                  `${counted(resources.requests, "request", number)}${resources.cached > 0 ? ` (${number(resources.cached)} more from cache${resources.failuresCached ? `, ${counted(resources.failuresCached, "failure", number)}` : ""})` : ""}${resources.logged > 0 ? ` (${number(resources.logged)} more from the browser)` : ""}`,
              )
            : "",
        runs.length > 0 ? row("extractors", runs.join(", ")) : "",
        hits.length > 0 ? row("cached", hits.join(", ")) : "",
    ].filter(Boolean);
}
