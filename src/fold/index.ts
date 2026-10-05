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

// Per (group, rule): one template-level finding once failures saturate the group.
export function fold(run: RuleRun, options: FoldConfig | false): Finding[] {
    const out = run.findings.filter((finding) => finding.scope !== "page");
    const byCell = new Map<string, Finding[]>();
    for (const finding of run.findings) {
        if (finding.scope !== "page") continue;
        const key = cell(finding.group as string, finding.rule);
        byCell.set(key, [...(byCell.get(key) ?? []), finding]);
    }
    for (const [key, unordered] of byCell) {
        const [group, rule] = key.split("\t") as [string, string];
        const findings = unordered.toSorted((a, b) => a.url.localeCompare(b.url));
        const failed = new Set(findings.map((finding) => finding.url)).size;
        const applicable = run.applicable.get(key) ?? failed;
        const ratio = failed / applicable;
        const isFolded = options !== false && applicable >= options.min && ratio >= options.threshold;
        log.debug({ group, rule, failed, applicable, ratio: Number(ratio.toFixed(2)), folded: isFolded }, "fold");
        if (!isFolded) {
            out.push(...findings);
            if (options !== false && applicable >= options.min && ratio > HETEROGENEOUS) {
                out.push({ rule: "groups/heterogeneous", severity: "info", score: 2, scope: "group", url: findings[0]?.url as string, group, ...said("{rule} fails on {count} of {total} pages; the group likely spans two templates", { rule, count: failed, total: applicable }) });
            }
            continue;
        }
        const samples = [...new Set(findings.map((finding) => finding.url))].slice(0, 3);
        const first = findings[0] as Finding;
        const located = samples.map((url) => [url, findings.filter((finding) => finding.url === url).flatMap((finding) => finding.locations ?? [])] as const).filter(([, locations]) => locations.length > 0);
        const { locations: _locations, data: _data, evidence: _evidence, ...shared } = first;
        const score = round(Math.max(...findings.map((finding) => scoreOf(finding))));
        const kept = findings.filter((finding) => samples.includes(finding.url));
        const data = Object.assign({}, ...kept.map((finding) => finding.data ?? {})) as NonNullable<Finding["data"]>;
        const evidence = new Map(kept.flatMap((finding) => finding.evidence ?? []).map((read) => [`${read.bucket}:${read.key}`, read])).values().toArray();
        out.push({
            ...shared,
            severity: levelOf(score),
            score,
            scope: "group",
            occurrences: failed,
            coverage: Number(ratio.toFixed(2)),
            samples,
            url: samples[0] as string,
            ...(run.sampled?.has(key) && { sampled: applicable }),
            ...(located.length > 0 && { sampleLocations: Object.fromEntries(located) }),
            ...(Object.keys(data).length > 0 && { data }),
            ...(evidence.length > 0 && { evidence }),
        });
    }
    log.debug({ before: run.findings.length, after: out.length }, "fold done");
    return out;
}
