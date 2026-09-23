// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";
import type { Finding } from "../rules/types.ts";

const ORDER = { error: 0, warning: 1, info: 2 };
const LIST = 5;
const KILOBYTES = new Intl.NumberFormat(undefined, { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 });
const SECONDS = new Intl.NumberFormat(undefined, { style: "unit", unit: "second", maximumFractionDigits: 1 });

// At most LIST URLs on the detail line, the rest as a count.
function list(urls: string[]): string {
    return urls.length > LIST ? `${urls.slice(0, LIST).join(", ")} … and ${urls.length - LIST} more` : urls.join(", ");
}

// A fold shows its samples; an aggregate its URL list, and its own URL when that is not one of them.
function line(finding: Finding): string[] {
    const head = `  ${finding.severity.padEnd(7)} ${finding.rule}`;
    if (finding.occurrences !== undefined) {
        return [`${head} — ${finding.occurrences} pages (${Math.round((finding.coverage ?? 0) * 100)}%): ${finding.message}`, `          e.g. ${list(finding.samples ?? [])}`];
    }
    if (!finding.urls) return [`${head} ${finding.url}: ${finding.message}`];
    const subject = finding.urls.includes(finding.url) ? "—" : `${finding.url}:`;
    return [`${head} ${subject} ${finding.message}`, `          ${list(finding.urls)}`];
}

// Findings grouped by group then rule, site-wide ones last, then the totals.
export function formatHuman(report: Report): string {
    const out: string[] = [];
    const groups = new Map<string, Finding[]>();
    for (const finding of report.findings) {
        const key = finding.scope === "site" ? "site" : (finding.group as string);
        groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
    for (const [group, findings] of groups) {
        const pages = report.summary.groups[group] ?? 0;
        out.push(group === "site" ? "site" : `${group} (${pages} pages)`);
        findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url));
        for (const finding of findings) out.push(...line(finding));
    }
    const counts = Object.keys(ORDER).map((severity) => `${report.findings.filter((finding) => finding.severity === severity).length} ${severity}`);
    const { pages, bytes, durationMs, statuses } = report.summary;
    const answers = Object.entries(statuses).map(([status, count]) => `${count} × ${status}`);
    out.push(`${pages} pages (${answers.join(", ")}), ${KILOBYTES.format(bytes / 1000)} in ${SECONDS.format(durationMs / 1000)}, ${report.findings.length} findings (${counts.join(", ")})`);
    return out.join("\n");
}
