// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { VERSION } from "../agent.ts";
import type { Report } from "../index.ts";
import { fixFor } from "../rules/fix.ts";
import { inEnglish, valuesAt, writtenAll } from "../rules/message.ts";
import { scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide, Severity } from "../rules/types.ts";

const SCHEMA = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";
const SECURITY = /^(tls|cookies|dns|mail|sshfp)\/|^http\/(hsts|csp|content-type-options|referrer-policy|frame-options|server-disclosure|permissions-policy|coop|coep|corp|reporting|no-x-xss|deprecated-header)/;
const LEVEL: Record<Exclude<Severity, "off">, string> = { error: "error", warning: "warning", info: "note", hint: "none" };

function location(uri: string) {
    return { physicalLocation: { artifactLocation: { uri } } };
}

// A location carrying the values measured there as its message, when there are any.
function measured(finding: Finding, uri: string) {
    const values = valuesAt(finding, uri, inEnglish);
    return { ...location(uri), ...(values.length > 0 && { message: { text: values.join(", ") } }) };
}

// Samples beyond the primary location, for a folded or site-wide finding.
function relatedLocations(finding: Finding) {
    const extra = (finding.samples ?? finding.urls ?? []).filter((url) => url !== finding.url);
    return extra.length === 0 ? undefined : extra.map((uri, id) => ({ id, ...measured(finding, uri) }));
}

// A template’s placeholders as SARIF’s positional `{0}`, in the order its variables are named.
function positional(text: string, names: string[]): string {
    return text.replaceAll(/\{(\w+)\}/g, (match, name: string) => (names.includes(name) ? `{${names.indexOf(name)}}` : match));
}

// The message: the English text, and for a template its message string ID and arguments (SARIF 2.1.0 §3.11.7).
function message(finding: Finding, ids: Map<string, string>) {
    const id = finding.text === undefined ? undefined : ids.get(`${finding.rule}\t${finding.text}`);
    const variables = writtenAll(finding.variables, inEnglish);
    return { text: finding.message, ...(id && { id, arguments: Object.values(variables) }) };
}

function toResult(finding: Finding, ids: Map<string, string>) {
    const related = relatedLocations(finding);
    return {
        ruleId: finding.rule,
        level: LEVEL[finding.severity],
        rank: scoreOf(finding) * 10,
        message: message(finding, ids),
        locations: [measured(finding, finding.url)],
        ...(finding.occurrences !== undefined && { occurrenceCount: finding.occurrences }),
        ...(related && { relatedLocations: related }),
        ...(finding.evidence && { properties: { evidence: finding.evidence } }),
    };
}

// One message string ID per distinct template, numbered within its rule, and the rule’s strings by ID.
function messageStrings(findings: Finding[]): { ids: Map<string, string>; byRule: Map<string, Record<string, { text: string }>> } {
    const ids = new Map<string, string>();
    const byRule = new Map<string, Record<string, { text: string }>>();
    for (const finding of findings) {
        if (finding.text === undefined || ids.has(`${finding.rule}\t${finding.text}`)) continue;
        const strings = byRule.get(finding.rule) ?? {};
        const id = `m${Object.keys(strings).length}`;
        strings[id] = { text: positional(finding.text, Object.keys(finding.variables ?? {})) };
        ids.set(`${finding.rule}\t${finding.text}`, id);
        byRule.set(finding.rule, strings);
    }
    return { ids, byRule };
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
function toRules(findings: Finding[], strings: Map<string, Record<string, { text: string }>>, guides: Report["rules"] = {}) {
    const ids = [...new Set(findings.map((finding) => finding.rule))].toSorted((a, b) => a.localeCompare(b));
    return ids.map((id) => ({ id, shortDescription: { text: id }, ...(strings.has(id) && { messageStrings: strings.get(id) }), ...(guides[id] && help(guides[id])), ...security(id, findings) }));
}

// The run's totals as a SARIF invocation; the summary rides in its property bag.
function toInvocation({ started, ...summary }: Report["summary"]) {
    const endTimeUtc = new Date(Date.parse(started) + summary.durationMs).toISOString();
    return { executionSuccessful: true, startTimeUtc: started, endTimeUtc, properties: summary };
}

// SARIF 2.1.0: one run, one tool. Folded findings carry occurrenceCount + relatedLocations (AGENTS.md ## Folding).
export function formatSarif(report: Report): string {
    const { ids, byRule } = messageStrings(report.findings);
    const sarif = {
        $schema: SCHEMA,
        version: "2.1.0",
        runs: [
            {
                tool: { driver: { name: "spiderlint", version: VERSION, rules: toRules(report.findings, byRule, report.rules) } },
                invocations: [toInvocation(report.summary)],
                results: report.findings.map((finding) => toResult(finding, ids)),
            },
        ],
    };
    return JSON.stringify(sarif, undefined, 2);
}
