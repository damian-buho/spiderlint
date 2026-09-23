// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ConfigError } from "../config/index.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { builtin } from "./builtin.ts";
import { isPageRule, type AggregateRule, type Finding, type PageRule, type Rule, type RuleSpec, type Severity } from "./types.ts";

// strictTypes off so `{ minItems: 1 }` needs no `type: array` beside it.
const ajv = new Ajv2020({ strictTypes: false });

// Dotted path into a facts document; absent stays undefined.
export function get(facts: unknown, path: string): unknown {
    let value: unknown = facts;
    for (const key of path.split(".")) {
        if (value === null || typeof value !== "object") return undefined;
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

// JSON pointer walk for the value an AJV error points at.
function at(value: unknown, pointer: string): unknown {
    return pointer === "" ? value : get(value, pointer.slice(1).replaceAll("/", "."));
}

// Short rendering of an offending value for the finding message.
export function describe(value: unknown): string {
    if (typeof value === "string") return `${value.length} characters: “${value.length > 60 ? `${value.slice(0, 57)}…` : value}”`;
    if (Array.isArray(value)) return `${value.length} items`;
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

function message(fact: string, value: unknown, error: ErrorObject): string {
    return value === undefined ? `${fact} is absent` : `${fact}${error.instancePath} ${error.message} (got ${describe(at(value, error.instancePath))})`;
}

function severityOf(id: string, spec: RuleSpec, fallback: Severity): Exclude<Severity, "off"> {
    const severity = spec.severity ?? fallback;
    if (severity === "off") throw new ConfigError(`rule ${id}: compiled while off`);
    return severity;
}

type Guard = (page: Facts) => boolean;

// A `when` entry is a constant to equal, or a schema object the fact must satisfy.
function guard(id: string, when: Record<string, unknown> | undefined): Guard {
    const tests = Object.entries(when ?? {}).map(([path, expected]) => {
        const test = typeof expected === "object" && expected !== null ? ajv.compile(expected) : (actual: unknown) => actual === expected;
        return { path, expected, test };
    });
    return (page) => {
        for (const { path, expected, test } of tests) {
            const actual = get(page, path);
            if (test(actual)) continue;
            log.debug({ rule: id, url: page.url.href, when: path, expected, actual }, "rule skipped");
            return true;
        }
        return false;
    };
}

// A page whose facts lack the extractor's top-level key is skipped, not failed.
function compilePage(id: string, spec: RuleSpec, fact: string, validate: ValidateFunction): PageRule {
    const severity = severityOf(id, spec, "warning");
    const root = fact.split(".", 1)[0] as string;
    const isSkipped = guard(id, spec.when);
    return {
        meta: { id, severity, scope: "page", facts: [fact], docs: spec.docs },
        check(page) {
            if (isSkipped(page)) return;
            if (get(page, root) === undefined) {
                log.debug({ rule: id, url: page.url.href, extractor: root }, "rule skipped");
                return;
            }
            const value = get(page, fact);
            if (validate(value)) return [];
            const error = validate.errors?.[0] as ErrorObject;
            return [{ rule: id, severity, scope: "page", url: page.url.href, group: page.group, message: message(fact, value, error), value }];
        },
    };
}

// One finding per value held by two or more distinct URLs.
function compileUnique(id: string, spec: RuleSpec, fact: string): AggregateRule {
    const severity = severityOf(id, spec, "warning");
    const scope = spec.scope === "group" ? "group" : "site";
    const isSkipped = guard(id, spec.when);
    return {
        meta: { id, severity, scope, facts: [fact], docs: spec.docs },
        check(pages, group) {
            const byValue = new Map<string, string[]>();
            for (const page of pages) {
                if (isSkipped(page)) continue;
                const value = get(page, fact);
                if (typeof value !== "string") continue;
                byValue.set(value, [...(byValue.get(value) ?? []), page.url.href]);
            }
            const findings: Finding[] = [];
            for (const [value, urls] of byValue) {
                if (urls.length < 2) continue;
                log.debug({ rule: id, group, value, pages: urls.length }, "duplicate value");
                findings.push({ rule: id, severity, scope, url: urls[0] as string, group, message: `${fact} is shared by ${urls.length} pages (${describe(value)})`, value, urls });
            }
            return findings;
        },
    };
}

// A built-in page rule honours `when` as a declarative one does.
function guarded(rule: Rule, isSkipped: Guard): Rule {
    return isPageRule(rule) ? { ...rule, check: (page) => (isSkipped(page) ? undefined : rule.check(page)) } : rule;
}

// `fact` + `expect` is a page rule, `unique` an aggregate, a bare ID a built-in; else a config error.
export function compileRule(id: string, spec: RuleSpec): Rule {
    if (spec.unique) return compileUnique(id, spec, spec.unique);
    if (!spec.fact && !spec.expect) {
        const make = builtin[id];
        if (!make) throw new ConfigError(`rule ${id}: needs fact and expect, or unique, or a built-in ID`);
        return guarded(make(severityOf(id, spec, "warning")), guard(id, spec.when));
    }
    if (!spec.fact || !spec.expect) throw new ConfigError(`rule ${id}: needs both fact and expect`);
    try {
        return compilePage(id, spec, spec.fact, ajv.compile(spec.expect));
    } catch (error) {
        throw new ConfigError(`rule ${id}: expect ${error instanceof Error ? error.message : String(error)}`);
    }
}
