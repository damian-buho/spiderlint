// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";

// Summary and findings; facts stay behind `spiderlint facts <url>`.
export function formatJson(report: Report): string {
    const groups: Record<string, number> = {};
    for (const page of report.pages) groups[page.group] = (groups[page.group] ?? 0) + 1;
    return JSON.stringify({ summary: { pages: report.pages.length, groups, findings: report.findings.length }, findings: report.findings }, undefined, 2);
}
