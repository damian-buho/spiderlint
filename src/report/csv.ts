// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";
import { scoreOf } from "../rules/score.ts";
import type { Finding } from "../rules/types.ts";

const COLUMNS = ["severity", "score", "rule", "scope", "group", "url", "message", "occurrences", "locations"] as const;

// RFC 4180 field: quoted when it holds a quote, comma or line break, quotes doubled.
export function field(value: string | number | boolean | undefined): string {
    const text = String(value ?? "");
    return /[\n\r",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toRow(finding: Finding): string {
    const cells = [finding.severity, scoreOf(finding).toFixed(1), finding.rule, finding.scope, finding.group, finding.url, finding.message, finding.occurrences, finding.locations?.join("\n")];
    return cells.map((cell) => field(cell)).join(",");
}

// RFC 4180 CSV with a header row, one row per finding, CRLF line endings.
export function formatCsv(report: Report): string {
    return [COLUMNS.join(","), ...report.findings.map((finding) => toRow(finding))].join("\r\n");
}
