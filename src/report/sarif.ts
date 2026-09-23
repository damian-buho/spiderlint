// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import type { Report } from "../index.ts";
import type { Finding, Severity } from "../rules/types.ts";

const SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const LEVEL: Record<Exclude<Severity, "off">, string> = { error: "error", warning: "warning", info: "note" };

function location(uri: string) {
    return { physicalLocation: { artifactLocation: { uri } } };
}

// Samples beyond the primary location, for a folded or site-wide finding.
function relatedLocations(urls: string[] | undefined, primary: string) {
    const extra = (urls ?? []).filter((url) => url !== primary);
    return extra.length === 0 ? undefined : extra.map((uri, id) => ({ id, ...location(uri) }));
}

function toResult(finding: Finding) {
    const related = relatedLocations(finding.samples ?? finding.urls, finding.url);
    return {
        ruleId: finding.rule,
        level: LEVEL[finding.severity],
        message: { text: finding.message },
        locations: [location(finding.url)],
        ...(finding.occurrences !== undefined && { occurrenceCount: finding.occurrences }),
        ...(related && { relatedLocations: related }),
    };
}

// One driver rule per distinct rule ID seen in the findings; docs are not threaded through Report yet.
function toRules(findings: Finding[]) {
    const ids = [...new Set(findings.map((finding) => finding.rule))].toSorted((a, b) => a.localeCompare(b));
    return ids.map((id) => ({ id, shortDescription: { text: id } }));
}

// The run's totals as a SARIF invocation; the summary rides in its property bag.
function toInvocation({ started, ...summary }: Report["summary"]) {
    const endTimeUtc = new Date(Date.parse(started) + summary.durationMs).toISOString();
    return { executionSuccessful: true, startTimeUtc: started, endTimeUtc, properties: summary };
}

// SARIF 2.1.0: one run, one tool. Folded findings carry occurrenceCount + relatedLocations (AGENTS.md ## Folding).
export function formatSarif(report: Report): string {
    const version = (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
    const sarif = {
        $schema: SCHEMA,
        version: "2.1.0",
        runs: [
            {
                tool: { driver: { name: "spiderlint", version, rules: toRules(report.findings) } },
                invocations: [toInvocation(report.summary)],
                results: report.findings.map((finding) => toResult(finding)),
            },
        ],
    };
    return JSON.stringify(sarif, undefined, 2);
}
