// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ConfigError } from "../config/index.ts";
import { subjectPath } from "../facts/sites.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { ruleMaker } from "../plugins/index.ts";
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

// A string past `max` keeps its head and tail around one ellipsis, since either end may hold the fix.
function elide(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, Math.ceil(max / 2))}…${text.slice(text.length - Math.floor(max / 2) + 1)}` : text;
}

// Rendering of an offending value for the finding message; a title or description shows whole.
export function describe(value: unknown): string {
    if (typeof value === "string") return `${value.length} characters: “${elide(value, 200)}”`;
    if (Array.isArray(value)) return value.length > 0 && value.every((item) => typeof item === "string") ? `${value.length} items: ${elide(value.map((item) => `“${item}”`).join(", "), 200)}` : `${value.length} items`;
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

// The rule’s own sentence with `{got}` filled in, else AJV’s wording against the fact path.
function message(fact: string, value: unknown, error: ErrorObject, text: string | undefined): string {
    const got = value === undefined ? "none" : describe(at(value, error.instancePath));
    if (text) return text.replaceAll("{got}", () => got);
    return value === undefined ? `${fact} is absent` : `${fact}${error.instancePath} ${error.message} (got ${got})`;
}

function severityOf(id: string, spec: RuleSpec, fallback: Severity): Exclude<Severity, "off"> {
    const severity = spec.severity ?? fallback;
    if (severity === "off") throw new ConfigError(`rule ${id}: compiled while off`);
    return severity;
}

// Whether the document at `subject` fails its `when`; a page is its own URL.
type Guard = (facts: object, subject: string) => boolean;

// A `when` entry is a constant to equal, or a schema object the fact must satisfy.
function guard(id: string, when: Record<string, unknown> | undefined): Guard {
    const tests = Object.entries(when ?? {}).map(([path, expected]) => {
        const test = typeof expected === "object" && expected !== null ? ajv.compile(expected) : (actual: unknown) => actual === expected;
        return { path, expected, test };
    });
    return (facts, subject) => {
        for (const { path, expected, test } of tests) {
            const actual = get(facts, path);
            if (test(actual)) continue;
            log.debug({ rule: id, url: subject, when: path, expected, actual }, "rule skipped");
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
        meta: { id, severity, scope: "page", facts: [fact], docs: spec.docs, fix: spec.fix },
        check(page) {
            if (isSkipped(page, page.url.href)) return;
            if (get(page, root) === undefined) {
                log.debug({ rule: id, url: page.url.href, extractor: root }, "rule skipped");
                return;
            }
            const value = get(page, fact);
            if (validate(value)) return [];
            const error = validate.errors?.[0] as ErrorObject;
            return [{ rule: id, severity, scope: "page", url: page.url.href, group: page.group, message: message(fact, value, error, spec.message), value }];
        },
    };
}

// One finding per value held by two or more distinct URLs.
function compileUnique(id: string, spec: RuleSpec, fact: string): AggregateRule {
    const severity = severityOf(id, spec, "warning");
    const scope = spec.scope === "group" ? "group" : "site";
    const isSkipped = guard(id, spec.when);
    return {
        meta: { id, severity, scope, facts: [fact], docs: spec.docs, fix: spec.fix },
        check(pages, group) {
            const byValue = new Map<string, string[]>();
            for (const page of pages) {
                if (isSkipped(page, page.url.href)) continue;
                const value = get(page, fact);
                if (typeof value !== "string") continue;
                byValue.set(value, [...(byValue.get(value) ?? []), page.url.href]);
            }
            const findings: Finding[] = [];
            for (const [value, urls] of byValue) {
                if (urls.length < 2) continue;
                log.debug({ rule: id, group, value, pages: urls.length }, "duplicate value");
                findings.push({ rule: id, severity, scope, url: urls[0] as string, group, message: spec.message?.replaceAll("{got}", () => describe(value)) ?? `${fact} is shared by ${urls.length} pages (${describe(value)})`, value, urls });
            }
            return findings;
        },
    };
}

// One check per origin or host whose facts carry the extractor’s key, keyed by that subject; only `when` paths under the same subjects apply.
// A subject whose path runs through a probe robots.txt withheld is skipped, not failed.
function isWithheld(facts: unknown, path: string, rule: string, subject: string): boolean {
    const parts = path.split(".");
    const withheld = parts.find((_part, index) => (get(facts, parts.slice(0, index + 1).join(".")) as { disallowed?: unknown } | undefined)?.disallowed === true);
    if (withheld) log.debug({ rule, subject, path, withheld }, "rule skipped, robots.txt withheld its probe");
    return withheld !== undefined;
}

function compileSubject(id: string, spec: RuleSpec, fact: string, subject: NonNullable<ReturnType<typeof subjectPath>>, validate: ValidateFunction): AggregateRule {
    const severity = severityOf(id, spec, "warning");
    const prefix = `site.${subject.kind}.*.`;
    const when = Object.entries(spec.when ?? {}).filter(([path]) => path.startsWith(prefix));
    log.debug({ rule: id, kind: subject.kind, when: when.length, ignored: Object.keys(spec.when ?? {}).length - when.length }, "subject rule compiled");
    const isSkipped = guard(id, Object.fromEntries(when.map(([path, expected]) => [path.slice(prefix.length), expected])));
    return {
        meta: { id, severity, scope: "site", facts: [fact], docs: spec.docs, fix: spec.fix },
        check(_pages, _group, site) {
            const judged = Object.entries(site?.[subject.kind] ?? {}).filter(([name, facts]) => facts[subject.id] !== undefined && !isSkipped(facts, name) && !isWithheld(facts, subject.path, id, name));
            log.debug({ rule: id, subjects: judged.length }, "subjects judged");
            return judged.length === 0 ? undefined : judged.flatMap(([name, facts]) => {
                const value = get(facts, subject.path);
                if (validate(value)) return [];
                const error = validate.errors?.[0] as ErrorObject;
                return [{ rule: id, severity, scope: "site" as const, url: name, message: message(fact, value, error, spec.message), value }];
            });
        },
    };
}

// A built-in page rule honours `when` as a declarative one does.
function guarded(rule: Rule, isSkipped: Guard): Rule {
    return isPageRule(rule) ? { ...rule, check: (page: Facts) => (isSkipped(page, page.url.href) ? undefined : rule.check(page)) } : rule;
}

// `fact` + `expect` is a page rule, `unique` an aggregate, a bare ID a built-in; else a config error.
export function compileRule(id: string, spec: RuleSpec): Rule {
    if (spec.unique) return compileUnique(id, spec, spec.unique);
    if (!spec.fact && !spec.expect) {
        const make = ruleMaker(id);
        if (!make) throw new ConfigError(`rule ${id}: needs fact and expect, or unique, or a built-in ID`);
        const rule = make(severityOf(id, spec, "warning"));
        // A ruleset entry’s `docs` and `fix` win over the built-in’s own.
        Object.assign(rule.meta, spec.docs && { docs: spec.docs }, spec.fix && { fix: spec.fix });
        return guarded(rule, guard(id, spec.when));
    }
    if (!spec.fact || !spec.expect) throw new ConfigError(`rule ${id}: needs both fact and expect`);
    try {
        const subject = subjectPath(spec.fact);
        return subject ? compileSubject(id, spec, spec.fact, subject, ajv.compile(spec.expect)) : compilePage(id, spec, spec.fact, ajv.compile(spec.expect));
    } catch (error) {
        throw new ConfigError(`rule ${id}: expect ${error instanceof Error ? error.message : String(error)}`);
    }
}
