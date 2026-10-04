// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { VERSION } from "../agent.ts";
import type { Report } from "../index.ts";
import { fixFor } from "../rules/fix.ts";
import { scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide, Severity } from "../rules/types.ts";

const SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const SECURITY = /^(tls|cookies|dns|mail|sshfp)\/|^http\/(hsts|csp|content-type-options|referrer-policy|frame-options|server-disclosure|permissions-policy|coop|coep|corp|reporting|no-x-xss|deprecated-header)/;
const LEVEL: Record<Exclude<Severity, "off">, string> = { error: "error", warning: "warning", info: "note", hint: "none" };

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
        rank: scoreOf(finding) * 10,
        message: { text: finding.message },
        locations: [location(finding.url)],
        ...(finding.occurrences !== undefined && { occurrenceCount: finding.occurrences }),
        ...(related && { relatedLocations: related }),
    };
}

// The rule’s generic fix and docs link, which code scanning shows beside each alert.
function help({ fix, docs }: RuleGuide) {
    const text = [fix && fixFor(fix), docs].filter(Boolean);
    const markdown = [fix && fixFor(fix), docs && `[Documentation](${docs})`].filter(Boolean);
    return text.length === 0 ? {} : { help: { text: text.join("\n\n"), markdown: markdown.join("\n\n") }, ...(docs && { helpUri: docs }) };
}

// Code scanning reads the worst score of a security rule’s findings as its CVSS-style severity, "0.0" to "10.0".
function security(id: string, findings: Finding[]) {
    if (!SECURITY.test(id)) return {};
    const worst = Math.max(...findings.filter((finding) => finding.rule === id).map((finding) => scoreOf(finding)));
    return { properties: { "security-severity": worst.toFixed(1), tags: ["security"] } };
}

// One driver rule per distinct rule ID seen in the findings, with its help when the report carries its guide.
function toRules(findings: Finding[], guides: Report["rules"] = {}) {
    const ids = [...new Set(findings.map((finding) => finding.rule))].toSorted((a, b) => a.localeCompare(b));
    return ids.map((id) => ({ id, shortDescription: { text: id }, ...(guides[id] && help(guides[id])), ...security(id, findings) }));
}

// The run's totals as a SARIF invocation; the summary rides in its property bag.
function toInvocation({ started, ...summary }: Report["summary"]) {
    const endTimeUtc = new Date(Date.parse(started) + summary.durationMs).toISOString();
    return { executionSuccessful: true, startTimeUtc: started, endTimeUtc, properties: summary };
}

// SARIF 2.1.0: one run, one tool. Folded findings carry occurrenceCount + relatedLocations (AGENTS.md ## Folding).
export function formatSarif(report: Report): string {
    const sarif = {
        $schema: SCHEMA,
        version: "2.1.0",
        runs: [
            {
                tool: { driver: { name: "spiderlint", version: VERSION, rules: toRules(report.findings, report.rules) } },
                invocations: [toInvocation(report.summary)],
                results: report.findings.map((finding) => toResult(finding)),
            },
        ],
    };
    return JSON.stringify(sarif, undefined, 2);
}
