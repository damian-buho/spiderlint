// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { FoldConfig } from "../config/index.ts";
import { log } from "../logger.ts";
import { cell, type RuleRun } from "../rules/run.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";

const HETEROGENEOUS = 0.2;

// The guide of the advisory folding raises, which no ruleset carries.
export const HETEROGENEOUS_GUIDE: RuleGuide = { facts: ["group"], fix: "split the group’s `match` so each template gets its own group, then check with `spiderlint groups`" };

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
                out.push({ rule: "groups/heterogeneous", severity: "info", scope: "group", url: findings[0]?.url as string, group, message: `${rule} fails on ${failed} of ${applicable} pages; the group likely spans two templates` });
            }
            continue;
        }
        const samples = [...new Set(findings.map((finding) => finding.url))].slice(0, 3);
        const first = findings[0] as Finding;
        const located = samples.map((url) => [url, findings.filter((finding) => finding.url === url).flatMap((finding) => finding.locations ?? [])] as const).filter(([, locations]) => locations.length > 0);
        const { locations: _locations, ...shared } = first;
        out.push({ ...shared, scope: "group", occurrences: failed, coverage: Number(ratio.toFixed(2)), samples, url: samples[0] as string, ...(run.sampled?.has(key) && { sampled: applicable }), ...(located.length > 0 && { sampleLocations: Object.fromEntries(located) }) });
    }
    log.debug({ before: run.findings.length, after: out.length }, "fold done");
    return out;
}
