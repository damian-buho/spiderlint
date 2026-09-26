// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Report } from "../index.ts";
import type { Finding } from "../rules/types.ts";

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(text: string): string {
    return text.replaceAll(/["&'<>]/g, (char) => XML_ESCAPES[char] ?? char);
}

// `line` and `column` from a `line:column selector` location, when the first one has them.
function position(finding: Finding): string {
    const match = /^(\d+):(\d+)/.exec(finding.locations?.[0] ?? "");
    return match ? ` line="${match[1]}" column="${match[2]}"` : "";
}

function toError(finding: Finding): string {
    return `    <error${position(finding)} severity="${finding.severity}" message="${escapeXml(finding.message)}" source="spiderlint.${escapeXml(finding.rule)}"/>`;
}

// Checkstyle XML: one `<file>` per URL, in first-seen order, one `<error>` per finding.
export function formatCheckstyle(report: Report): string {
    const byUrl = Map.groupBy(report.findings, (finding) => finding.url);
    const files = [...byUrl].map(([url, findings]) => [`  <file name="${escapeXml(url)}">`, ...findings.map((finding) => toError(finding)), "  </file>"].join("\n"));
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<checkstyle version="10.12.0">', ...files, "</checkstyle>"].join("\n");
}
