// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";

// Summary, findings and their rules’ docs; facts stay behind `spiderlint facts <url>`.
export function formatJson(report: Report): string {
    return JSON.stringify({ summary: report.summary, findings: report.findings, ...(report.rules && { rules: report.rules }) }, undefined, 2);
}
