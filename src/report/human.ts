// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";

// One line per page, one per finding, then the count.
export function formatHuman(report: Report): string {
    const pages = report.pages.map((page) => `${page.http.status} ${page.url.href} [${page.group}] ${page.html?.title ?? "(no title)"}`);
    const findings = report.findings.map((finding) => `${finding.severity} ${finding.rule} ${finding.url}: ${finding.message}`);
    return [...pages, ...findings, `${report.pages.length} page(s), ${report.findings.length} finding(s)`].join("\n");
}
