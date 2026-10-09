// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleChecks } from "../report/rating.ts";
import { scoreOf, weight } from "./score.ts";
import { isPageRule, type AggregateRule, type Evidence, type Finding, type PageRule, type Rule } from "./types.ts";

export interface RuleRun {
    findings: Finding[];
    applicable: Map<string, number>;
    checks: { total: number; failed: number; errored: number; cost: number };
    // The same checks by rule ID, so the counts sum to `checks`.
    perRule: Map<string, RuleChecks>;
    // Cells whose rule saw only the group’s sample.
    sampled?: Set<string>;
}

// Key of the (group, rule) cell the fold reads.
export function cell(group: string, rule: string): string {
    return `${group}\t${rule}`;
}

// One subject a rule judged, none when it had no pages or is a hint; it fails on any finding above `info`, at the cost of its worst score.
function judged(run: RuleRun, found: Finding[], rule: Rule, pages = 1): void {
    if (pages === 0 || rule.meta.severity === "hint") return;
    run.checks.total += 1;
    if (found.some((finding) => finding.severity === "error")) run.checks.errored += 1;
    const failing = found.filter((finding) => finding.severity !== "info" && finding.severity !== "hint");
    const tally = run.perRule.get(rule.meta.id) ?? { checks: 0, failed: 0, pages: 0 };
    run.perRule.set(rule.meta.id, { checks: tally.checks + 1, failed: tally.failed + (failing.length > 0 ? 1 : 0), pages: tally.pages + pages });
    if (failing.length === 0) return;
    run.checks.failed += 1;
    const worst = Math.max(...failing.map((finding) => scoreOf(finding)));
    run.checks.cost = Number((run.checks.cost + weight(worst)).toFixed(4));
}

// How the crawl read a page: when, by which crawler, and whether the origin only confirmed a stored copy.
export function pageEvidence(page: Facts): Evidence {
    return { bucket: "pages", key: page.url.href, ...(page.crawl.at && { at: page.crawl.at }), via: page.http.revalidated ? "revalidated" : "network", ...(page.crawl.mode && { mode: page.crawl.mode }) };
}

// One page rule over one group; `undefined` results are `when`-skips and do not count.
function runPageRule(rule: PageRule, members: Facts[], group: string, run: RuleRun, site: SiteFacts): void {
    let applicable = 0;
    for (const page of members) {
        const found = rule.check(page, site);
        if (found === undefined) continue;
        applicable += 1;
        judged(run, found, rule);
        const read = pageEvidence(page);
        run.findings.push(...found.map((finding) => ({ ...finding, evidence: [read, ...(finding.evidence ?? [])] })));
    }
    run.applicable.set(cell(group, rule.meta.id), applicable);
}

// Page and group rules run within their group; site rules run once over the crawl.
export function runRules(pages: Facts[], rulesByGroup: Map<string, Rule[]>, facts: SiteFacts): RuleRun {
    const run: RuleRun = { findings: [], applicable: new Map(), perRule: new Map(), checks: { total: 0, failed: 0, errored: 0, cost: 0 } };
    const site = new Map<string, AggregateRule>();
    for (const [group, rules] of rulesByGroup) {
        const members = pages.filter((page) => page.group === group);
        for (const rule of rules) {
            const before = run.findings.length;
            if (isPageRule(rule)) runPageRule(rule, members, group, run, facts);
            else if (rule.meta.scope === "group") {
                const found = rule.check(members, group, facts) ?? [];
                judged(run, found, rule, members.length);
                run.findings.push(...found);
            } else if (!site.has(rule.meta.id)) site.set(rule.meta.id, rule);
            log.debug({ rule: rule.meta.id, group, pages: members.length, findings: run.findings.length - before }, "rule ran");
        }
    }
    for (const rule of site.values()) {
        const found = rule.check(pages, undefined, facts);
        log.debug({ rule: rule.meta.id, scope: "site", pages: pages.length, findings: found?.length, isSkipped: found === undefined }, "rule ran");
        if (found === undefined) continue;
        judged(run, found, rule, pages.length);
        run.findings.push(...found);
    }
    log.debug(run.checks, "checks judged");
    return run;
}
