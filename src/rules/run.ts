// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { isPageRule, type AggregateRule, type Finding, type PageRule, type Rule } from "./types.ts";

export interface RuleRun {
    findings: Finding[];
    applicable: Map<string, number>;
}

// Key of the (group, rule) cell the fold reads.
export function cell(group: string, rule: string): string {
    return `${group}\t${rule}`;
}

// One page rule over one group; `undefined` results are `when`-skips and do not count.
function runPageRule(rule: PageRule, members: Facts[], group: string, run: RuleRun): void {
    let applicable = 0;
    for (const page of members) {
        const found = rule.check(page);
        if (found === undefined) continue;
        applicable += 1;
        run.findings.push(...found);
    }
    run.applicable.set(cell(group, rule.meta.id), applicable);
}

// Page and group rules run within their group; site rules run once over the crawl.
export function runRules(pages: Facts[], rulesByGroup: Map<string, Rule[]>): RuleRun {
    const run: RuleRun = { findings: [], applicable: new Map() };
    const site = new Map<string, AggregateRule>();
    for (const [group, rules] of rulesByGroup) {
        const members = pages.filter((page) => page.group === group);
        for (const rule of rules) {
            const before = run.findings.length;
            if (isPageRule(rule)) runPageRule(rule, members, group, run);
            else if (rule.meta.scope === "group") run.findings.push(...rule.check(members, group));
            else if (!site.has(rule.meta.id)) site.set(rule.meta.id, rule);
            log.debug({ rule: rule.meta.id, group, pages: members.length, findings: run.findings.length - before }, "rule ran");
        }
    }
    for (const rule of site.values()) {
        const found = rule.check(pages);
        log.debug({ rule: rule.meta.id, scope: "site", pages: pages.length, findings: found.length }, "rule ran");
        run.findings.push(...found);
    }
    return run;
}
