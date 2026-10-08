// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, SiteFacts } from "../facts/types.ts";
import type { Scale } from "./score.ts";

export type Severity = "error" | "warning" | "info" | "hint" | "off";
export type Scope = "page" | "group" | "site";

// A value a formatter writes in the reader’s locale: as is, in its fact’s unit, as a multiple, as a time, or a fact’s label.
export type Datum = string | number | { fact: string; value: number } | { ratio: number } | { at: string } | { name: string };

// One observation a finding rests on: what was read, when the origin last confirmed it, and how this run got it.
export interface Evidence {
    bucket: string;
    key: string;
    at?: string;
    via: "network" | "cache" | "revalidated";
    mode?: "http" | "browser";
}

export interface Finding {
    rule: string;
    severity: Exclude<Severity, "off">;
    scope: Scope;
    url: string;
    group?: string;
    // The English sentence, `text` with `variables` filled in.
    message: string;
    // The sentence with `{name}` placeholders filled from `variables`, the same for every page; formatters bundle and translate by it.
    text?: string;
    variables?: Record<string, Datum>;
    // What was measured at each URL the finding names, keyed by URL.
    data?: Record<string, Record<string, Datum>>;
    evidence?: Evidence[];
    value?: unknown;
    // 0.0 to 9.9; the pipeline sets it, and its band is `severity`.
    score?: number;
    // Where on the page it is: one short line per element, as `line:column selector` or `selector <tag>`.
    locations?: string[];
    urls?: string[];
    occurrences?: number;
    coverage?: number;
    // The groups a site finding merged, each failing the rule whole the same way.
    groups?: string[];
    // Pages of the group an expensive extractor ran on, when it did not run on all of them.
    sampled?: number;
    samples?: string[];
    // The locations each sample page reported, keyed by its URL.
    sampleLocations?: Record<string, string[]>;
    // The edge or host owning the resource the finding is about.
    vendor?: string;
}

export interface RuleMeta {
    id: string;
    severity: Severity;
    scope: Scope;
    facts: string[];
    docs?: string;
    fix?: string;
    // The score a finding gets when nothing measured it; absent when `scale` computes it.
    score?: number;
    // How a dynamic score follows the finding’s value.
    scale?: Scale;
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
    // A number replaces the score; a scale computes it from the finding’s numeric value.
    score?: number | Scale;
    // Set when a level was written by hand, so a computed score stays inside its band.
    pinned?: true;
    docs?: string;
    fix?: string;
    message?: string;
    // A `site.hosts.*.` rule that also judges hosts the crawl only links or loads under its registrable domains; off by default.
    linked?: boolean;
}

export type RuleEntry = RuleSpec | Severity | number;

export interface RulesetConfig {
    description?: string;
    extends?: string[];
    when?: Record<string, unknown>;
    rules?: Record<string, RuleEntry>;
}
