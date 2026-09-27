// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, SiteFacts } from "../facts/types.ts";

export type Severity = "error" | "warning" | "info" | "hint" | "off";
export type Scope = "page" | "group" | "site";

export interface Finding {
    rule: string;
    severity: Exclude<Severity, "off">;
    scope: Scope;
    url: string;
    group?: string;
    message: string;
    value?: unknown;
    // Where on the page it is: one short line per element, as `line:column selector` or `selector <tag>`.
    locations?: string[];
    urls?: string[];
    occurrences?: number;
    coverage?: number;
    // Pages of the group an expensive extractor ran on, when it did not run on all of them.
    sampled?: number;
    samples?: string[];
    // The locations each sample page reported, keyed by its URL.
    sampleLocations?: Record<string, string[]>;
}

export interface RuleMeta {
    id: string;
    severity: Severity;
    scope: Scope;
    facts: string[];
    docs?: string;
    fix?: string;
    // The JSON Schema a declarative rule holds its fact to.
    expect?: Record<string, unknown>;
    // Also judges hosts the crawl only links or loads under its registrable domains.
    linked?: true;
}

// What a finding’s rule reads, expects and how to fix it, carried in the report for formatters.
export type RuleGuide = Pick<RuleMeta, "facts" | "expect" | "fix" | "docs">;

// `undefined` from a page rule means the `when` guard skipped it; `site` answers `when` paths under `site.`.
export interface PageRule {
    meta: RuleMeta & { scope: "page" };
    check(page: Facts, site?: SiteFacts): Finding[] | undefined;
}

// `undefined` from an aggregate rule means it had no subject to judge.
export interface AggregateRule {
    meta: RuleMeta & { scope: "group" | "site" };
    check(pages: Facts[], group?: string, site?: SiteFacts): Finding[] | undefined;
}

export type Rule = PageRule | AggregateRule;

// A TypeScript rule, built at the severity its ruleset gives it; a plugin’s also gets its validated settings.
export type Make = (severity: Exclude<Severity, "off">, settings?: unknown) => Rule;

// TS does not narrow a union on a nested discriminant, so the guard is explicit.
export function isPageRule(rule: Rule): rule is PageRule {
    return rule.meta.scope === "page";
}

// Declarative rule as written in a preset or the projectfile.
export interface RuleSpec {
    fact?: string;
    expect?: Record<string, unknown>;
    when?: Record<string, unknown>;
    unique?: string;
    scope?: Scope;
    severity?: Severity;
    docs?: string;
    fix?: string;
    message?: string;
    // A `site.hosts.*.` rule that also judges hosts the crawl only links or loads under its registrable domains; off by default.
    linked?: boolean;
}

export type RuleEntry = RuleSpec | Severity;

export interface RulesetConfig {
    description?: string;
    extends?: string[];
    when?: Record<string, unknown>;
    rules?: Record<string, RuleEntry>;
}
