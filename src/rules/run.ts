// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleChecks } from "../report/rating.ts";
import type { Verdict } from "../run.ts";
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
    // What each cell this run judged came to.
    verdicts: Map<string, Verdict>;
}

// Page rule results by cell, then page URL, so a later run replays a cell instead of checking it again.
export type PageResults = Map<string, Map<string, Finding[] | undefined>>;

// Key of the (group, rule) cell the fold reads.
export function cell(group: string, rule: string): string {
    return `${group}\t${rule}`;
}

// A cell’s verdict from what its rule found over `subjects` it applied to.
function verdictOf(found: Finding[], subjects: number): Verdict {
    if (subjects === 0) return { status: "untested" };
    if (found.length === 0) return { status: "passed" };
    const findings: Verdict["findings"] = {};
    for (const { severity } of found) findings[severity] = (findings[severity] ?? 0) + 1;
    return { status: "findings", findings };
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

// One page rule over one group, replaying any page `results` hold; `undefined` results are `when`-skips and do not count.
function runPageRule(rule: PageRule, members: Facts[], group: string, run: RuleRun, site: SiteFacts, results: PageResults): void {
    let applicable = 0;
    const key = cell(group, rule.meta.id);
    const held = results.get(key) ?? new Map<string, Finding[] | undefined>();
    results.set(key, held);
    const all: Finding[] = [];
    for (const page of members) {
        const found = held.has(page.url.href) ? held.get(page.url.href) : rule.check(page, site);
        held.set(page.url.href, found);
        if (found === undefined) continue;
        all.push(...found);
        applicable += 1;
        judged(run, found, rule);
        const read = pageEvidence(page);
        run.findings.push(...found.map((finding) => ({ ...finding, evidence: [read, ...(finding.evidence ?? [])] })));
    }
    run.applicable.set(key, applicable);
    run.verdicts.set(key, verdictOf(all, applicable));
}

// Page and group rules run within their group, page rules replaying `results`; site rules run once over the crawl.
export function runRules(pages: Facts[], rulesByGroup: Map<string, Rule[]>, facts: SiteFacts, results: PageResults = new Map()): RuleRun {
    const run: RuleRun = { findings: [], applicable: new Map(), perRule: new Map(), checks: { total: 0, failed: 0, errored: 0, cost: 0 }, verdicts: new Map() };
    const site = new Map<string, AggregateRule>();
    const siteGroups = new Map<string, string[]>();
    const pagesByGroup = Map.groupBy(pages, (page) => page.group);
    for (const [group, rules] of rulesByGroup) {
        const members = pagesByGroup.get(group) ?? [];
        for (const rule of rules) {
            const before = run.findings.length;
            if (isPageRule(rule)) runPageRule(rule, members, group, run, facts, results);
            else if (rule.meta.scope === "group") {
                const found = rule.check(members, group, facts) ?? [];
                judged(run, found, rule, members.length);
                run.findings.push(...found);
                run.verdicts.set(cell(group, rule.meta.id), verdictOf(found, members.length));
            } else {
                if (!site.has(rule.meta.id)) site.set(rule.meta.id, rule);
                const groups = siteGroups.get(rule.meta.id);
                if (groups) groups.push(group);
                else siteGroups.set(rule.meta.id, [group]);
            }
            log.debug({ rule: rule.meta.id, group, pages: members.length, findings: run.findings.length - before }, "rule ran");
        }
    }
    for (const rule of site.values()) {
        const found = rule.check(pages, undefined, facts);
        log.debug({ rule: rule.meta.id, scope: "site", pages: pages.length, findings: found?.length, isSkipped: found === undefined }, "rule ran");
        const groups = siteGroups.get(rule.meta.id) ?? [];
        for (const group of groups) run.verdicts.set(cell(group, rule.meta.id), verdictOf(found ?? [], found === undefined ? 0 : pages.length));
        if (found === undefined) continue;
        judged(run, found, rule, pages.length);
        run.findings.push(...found);
    }
    log.debug(run.checks, "checks judged");
    return run;
}
