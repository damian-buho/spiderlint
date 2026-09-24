// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, SiteFacts } from "../facts/types.ts";

export type Severity = "error" | "warning" | "info" | "off";
export type Scope = "page" | "group" | "site";

export interface Finding {
    rule: string;
    severity: Exclude<Severity, "off">;
    scope: Scope;
    url: string;
    group?: string;
    message: string;
    value?: unknown;
    urls?: string[];
    occurrences?: number;
    coverage?: number;
    samples?: string[];
}

export interface RuleMeta {
    id: string;
    severity: Severity;
    scope: Scope;
    facts: string[];
    docs?: string;
}

// `undefined` from a page rule means the `when` guard skipped it.
export interface PageRule {
    meta: RuleMeta & { scope: "page" };
    check(page: Facts): Finding[] | undefined;
}

export interface AggregateRule {
    meta: RuleMeta & { scope: "group" | "site" };
    check(pages: Facts[], group?: string, site?: SiteFacts): Finding[];
}

export type Rule = PageRule | AggregateRule;

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
}

export type RuleEntry = RuleSpec | Severity;

export interface RulesetConfig {
    description?: string;
    extends?: string[];
    when?: Record<string, unknown>;
    rules?: Record<string, RuleEntry>;
}
