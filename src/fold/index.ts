// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { FoldConfig } from "../config/index.ts";
import { log } from "../logger.ts";
import { said } from "../rules/message.ts";
import { cell, type RuleRun } from "../rules/run.ts";
import { levelOf, round, scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";

const HETEROGENEOUS = 0.2;

// The guide of the advisory folding raises, which no ruleset carries.
export const HETEROGENEOUS_GUIDE: RuleGuide = { facts: ["group"], fix: "Split the group’s `match` so each template gets its own group, then check with `spiderlint list-groups`." };

// One group’s findings of one rule that fail it whole, as the template’s result.
interface Saturated {
    group: string;
    findings: Finding[];
    failed: number;
    applicable: number;
    // The fold standing for them, when the group folded.
    folded?: Finding;
    isSampled: boolean;
}

// What a group’s result says: rule, sentence and locations, when every finding in it says the same; else none, and it never merges.
function signature(findings: Finding[]): string | undefined {
    const said = new Set(findings.map((finding) => JSON.stringify([finding.rule, finding.text ?? finding.message, finding.variables ?? {}, finding.locations ?? []])));
    return said.size === 1 ? (said.values().next().value as string) : undefined;
}

// The fold of one group’s findings: its samples, their locations and data, the worst score.
function folded(findings: Finding[], group: string, failed: number, applicable: number, isSampled: boolean): Finding {
    const samples = [...new Set(findings.map((finding) => finding.url))].slice(0, 3);
    const first = findings[0] as Finding;
    const located = samples.map((url) => [url, findings.filter((finding) => finding.url === url).flatMap((finding) => finding.locations ?? [])] as const).filter(([, locations]) => locations.length > 0);
    const { locations: _locations, data: _data, evidence: _evidence, ...shared } = first;
    const score = round(Math.max(...findings.map((finding) => scoreOf(finding))));
    const kept = findings.filter((finding) => samples.includes(finding.url));
    const data = Object.assign({}, ...kept.map((finding) => finding.data ?? {})) as NonNullable<Finding["data"]>;
    const evidence = new Map(kept.flatMap((finding) => finding.evidence ?? []).map((read) => [`${read.bucket}:${read.key}`, read])).values().toArray();
    return {
        ...shared,
        group,
        severity: levelOf(score),
        score,
        scope: "group",
        occurrences: failed,
        coverage: Number((failed / applicable).toFixed(2)),
        samples,
        url: samples[0] as string,
        ...(isSampled && { sampled: applicable }),
        ...(located.length > 0 && { sampleLocations: Object.fromEntries(located) }),
        ...(Object.keys(data).length > 0 && { data }),
        ...(evidence.length > 0 && { evidence }),
    };
}

// Groups failing a rule whole with the same result become one site finding naming them; a result one group alone shows stays its own.
function merged(results: Saturated[]): Finding[] {
    const [only] = results;
    if (only && results.length === 1) return only.folded ? [only.folded] : only.findings;
    const findings = results.flatMap((result) => result.findings).toSorted((a, b) => a.url.localeCompare(b.url));
    const failed = results.reduce((sum, result) => sum + result.failed, 0);
    const applicable = results.reduce((sum, result) => sum + result.applicable, 0);
    const { group: _group, ...shared } = folded(
        findings,
        "",
        failed,
        applicable,
        results.some((result) => result.isSampled),
    );
    return [{ ...shared, scope: "site", groups: results.map((result) => result.group) }];
}

// Per (group, rule): one template-level finding once failures saturate the group, and one site finding where several groups fail the same way.
export function fold(run: RuleRun, options: FoldConfig | false): Finding[] {
    const out = run.findings.filter((finding) => finding.scope !== "page");
    const byCell = new Map<string, Finding[]>();
    for (const finding of run.findings) {
        if (finding.scope !== "page") continue;
        const key = cell(finding.group as string, finding.rule);
        byCell.set(key, [...(byCell.get(key) ?? []), finding]);
    }
    const saturated = new Map<string, Saturated[]>();
    for (const [key, unordered] of byCell) {
        const [group, rule] = key.split("\t") as [string, string];
        const findings = unordered.toSorted((a, b) => a.url.localeCompare(b.url));
        const failed = new Set(findings.map((finding) => finding.url)).size;
        const applicable = run.applicable.get(key) ?? failed;
        const ratio = failed / applicable;
        const isFolded = options !== false && applicable >= options.min && ratio >= options.threshold;
        const isSampled = run.sampled?.has(key) === true;
        const result = options === false || (!isFolded && failed < applicable) ? undefined : signature(findings);
        log.debug({ group, rule, failed, applicable, ratio: Number(ratio.toFixed(2)), folded: isFolded, isSaturated: result !== undefined }, "fold");
        if (result !== undefined) {
            saturated.set(result, [...(saturated.get(result) ?? []), { group, findings, failed, applicable, isSampled, ...(isFolded && { folded: folded(findings, group, failed, applicable, isSampled) }) }]);
            continue;
        }
        if (isFolded) {
            out.push(folded(findings, group, failed, applicable, isSampled));
            continue;
        }
        out.push(...findings);
        if (options !== false && applicable >= options.min && ratio > HETEROGENEOUS) {
            out.push({ rule: "groups/heterogeneous", severity: "info", score: 2, scope: "group", url: findings[0]?.url as string, group, ...said("{rule} fails on {count} of {total} pages; the group likely spans two templates", { rule, count: failed, total: applicable }) });
        }
    }
    for (const [key, results] of saturated) {
        if (results.length > 1) log.debug({ key, groups: results.map((result) => result.group), findings: results.reduce((sum, result) => sum + result.findings.length, 0) }, "groups merged into one site finding");
        out.push(...merged(results));
    }
    log.debug({ before: run.findings.length, after: out.length }, "fold done");
    return out;
}
