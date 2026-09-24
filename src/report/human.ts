// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import type { Report } from "../index.ts";
import type { Finding } from "../rules/types.ts";
import { plain, type Paint, type Style } from "../color.ts";

const ORDER = { error: 0, warning: 1, info: 2 };
const TONE: Record<Finding["severity"], Style> = { error: "red", warning: "yellow", info: "blue" };
const LIST = 5;
const DETAIL = " ".repeat(10);
const NESTED = " ".repeat(12);
const KILOBYTES = new Intl.NumberFormat(undefined, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 });
const SECONDS = new Intl.NumberFormat(undefined, { style: "unit", unit: "second", maximumFractionDigits: 1 });

// At most LIST URLs on the detail line, the rest as a count.
function list(urls: string[], origin: string): string {
    const shown = urls.slice(0, LIST).map((url) => relative(url, origin)).join(", ");
    return urls.length > LIST ? `${shown} … and ${urls.length - LIST} more` : shown;
}

// At most LIST locations, each on its own line under what it locates, the rest as a count.
function located(locations: string[] | undefined, indent: string, paint: Paint): string[] {
    if (!locations || locations.length === 0) return [];
    const shown = locations.slice(0, LIST).map((location) => paint("dim", `${indent}at ${location}`));
    return locations.length > LIST ? [...shown, paint("dim", `${indent}… and ${locations.length - LIST} more`)] : shown;
}

// A fold’s samples; pages whose locations all match share one list under the URLs.
function sampled(finding: Finding, origin: string, paint: Paint): string[] {
    const samples = finding.samples ?? [];
    const byPage = finding.sampleLocations;
    const isShared = new Set(samples.map((url) => JSON.stringify(byPage?.[url] ?? []))).size === 1;
    return !byPage || isShared
        ? [paint("dim", `${DETAIL}e.g. ${list(samples, origin)}`), ...located(byPage?.[samples[0] as string], NESTED, paint)]
        : samples.flatMap((url) => [paint("dim", `${DETAIL}e.g. ${relative(url, origin)}`), ...located(byPage[url], NESTED, paint)]);
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
function bundled(same: Finding[], origin: string, paint: Paint): string[] {
    const first = same[0] as Finding;
    return [`${heading(first, paint)} — ${same.length} pages: ${shortMessage(first, origin)}`, ...same.flatMap((finding) => [paint("dim", `          ${relative(finding.url, origin)}`), ...located(finding.locations, NESTED, paint)])];
}

// A fold shows its samples; an aggregate its URL list, and its own URL when that is not one of them.
function line(finding: Finding, origin: string, paint: Paint): string[] {
    const url = relative(finding.url, origin);
    const message = shortMessage(finding, origin);
    const head = heading(finding, paint);
    if (finding.occurrences !== undefined) {
        return [`${head} — ${finding.occurrences} pages (${Math.round((finding.coverage ?? 0) * 100)}%): ${message}`, ...sampled(finding, origin, paint)];
    }
    if (!finding.urls) return [`${head} ${url}: ${message}`, ...located(finding.locations, DETAIL, paint)];
    const subject = finding.urls.includes(finding.url) ? "—" : `${url}:`;
    return [`${head} ${subject} ${message}`, paint("dim", `          ${list(finding.urls, origin)}`)];
}

// The shared origin once on top, findings grouped by group then rule, site-wide ones last, then the totals.
export function formatHuman(report: Report, paint: Paint = plain): string {
    const origin = singleOrigin(report.pages.map((page) => page.url.href));
    const out: string[] = origin ? [paint(["bold", "underline"], origin)] : [];
    const groups = new Map<string, Finding[]>();
    for (const finding of report.findings) {
        const key = finding.scope === "site" ? "site" : (finding.group as string);
        groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
    for (const [group, findings] of groups) {
        const pages = report.summary.groups[group] ?? 0;
        out.push(group === "site" ? paint("bold", "site") : `${paint("bold", group)} ${paint("dim", `(${pages} pages)`)}`);
        findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url));
        for (const same of bundle(findings)) out.push(...(same.length > 1 ? bundled(same, origin, paint) : line(same[0] as Finding, origin, paint)));
    }
    const counts = (Object.keys(ORDER) as Finding["severity"][]).map((severity) => {
        const count = report.findings.filter((finding) => finding.severity === severity).length;
        return count > 0 ? paint(TONE[severity], `${count} ${severity}`) : `${count} ${severity}`;
    });
    const { pages, bytes, durationMs, statuses } = report.summary;
    const answers = Object.entries(statuses).map(([status, count]) => `${count} × ${status}`);
    out.push(`${pages} pages (${answers.join(", ")}), ${KILOBYTES.format(bytes / 1000)} in ${SECONDS.format(durationMs / 1000)}, ${report.findings.length} findings (${counts.join(", ")})`);
    return out.join("\n");
}
