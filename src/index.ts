// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { defaults, type Config, type GroupConfig } from "./config/index.ts";
import { crawlBrowser } from "./crawl/browser.ts";
import { crawlHttp } from "./crawl/http.ts";
import type { Facts } from "./facts/types.ts";
import { fold } from "./fold/index.ts";
import { assignGroup, compileGroups } from "./groups/assign.ts";
import { log } from "./logger.ts";
import { compileRulesets } from "./rules/rulesets.ts";
import { runRules } from "./rules/run.ts";
import type { Finding, Rule } from "./rules/types.ts";
import { MemoryStore } from "./store/memory.ts";

export interface Report {
    pages: Facts[];
    findings: Finding[];
}

// `default` is the implicit catch-all; a group without `rules` gets `recommended`.
function groupsOf(config: Config): Record<string, Required<Pick<GroupConfig, "rules">> & GroupConfig> {
    const groups = { ...config.groups };
    groups.default ??= {};
    return Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, rules: group.rules ?? ["recommended"] }]));
}

// A page's referrers are the stored pages linking to it.
function referrers(pages: Facts[]): void {
    const byHref = new Map(pages.map((page) => [page.url.href, page]));
    for (const page of pages) {
        const internal = page.html?.links.internal ?? [];
        for (const href of internal) byHref.get(href)?.crawl.referrers.push(page.url.href);
    }
}

// crawl → facts → group → rules → fold; stream mode with an in-memory store.
export async function audit(overrides: Partial<Config>): Promise<Report> {
    const config: Config = { ...defaults(), ...overrides };
    const groups = groupsOf(config);
    const matchers = compileGroups(groups);
    const disabledRules = new Set(config.disabledRules);
    const rulesByGroup = new Map<string, Rule[]>(Object.entries(groups).map(([name, group]) => [name, compileRulesets(group.rules, config.rulesets, disabledRules, config.overrides)]));
    const store = new MemoryStore();
    const crawl = config.fetch === "http" ? crawlHttp : crawlBrowser;
    log.info({ seeds: config.seeds, fetch: config.fetch, scope: config.scope, maxPages: config.maxPages, groups: Object.keys(groups) }, "audit start");
    await crawl(config, (facts) => {
        facts.group = assignGroup(facts, matchers);
        store.add(facts);
    });
    referrers(store.pages);
    const findings = fold(runRules(store.pages, rulesByGroup), config.fold);
    log.info({ pages: store.pages.length, findings: findings.length }, "audit done");
    return { pages: store.pages, findings };
}
