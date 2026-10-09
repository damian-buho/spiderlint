// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { ConfigError } from "../config/index.ts";
import { label } from "../facts/labels.ts";
import { subjectPath } from "../facts/sites.ts";
import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { ruleMaker } from "../plugins/index.ts";
import { said } from "./message.ts";
import { baseScore, interpolate, levelOf, pin, scoreOf, type Level } from "./score.ts";
import { isPageRule, type AggregateRule, type Finding, type PageRule, type Rule, type RuleSpec, type Severity } from "./types.ts";

// strictTypes off so `{ minItems: 1 }` needs no `type: array` beside it; `format: uri` is an absolute URL a browser parses.
const ajv = new Ajv2020({ strictTypes: false, formats: { uri: (text: string) => URL.canParse(text) } });

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
    if (Array.isArray(value) && value.length === 0) return "none";
    if (Array.isArray(value)) return value.every((item) => typeof item === "string" || typeof item === "number") ? `${value.length} items: ${elide(value.map((item) => (typeof item === "string" ? `“${item}”` : String(item))).join(", "), 200)}` : `${value.length} items`;
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
}

// The rule’s own sentence as a template over `{got}` and `{field}`, else AJV’s wording against the fact path.
function message(fact: string, value: unknown, error: ErrorObject, text: string | undefined): Pick<Finding, "message" | "text" | "variables"> {
    const actual = value === undefined ? undefined : at(value, error.instancePath);
    // A length says nothing against an exact value, so a `const` or `enum` miss shows the value alone.
    const got = value === undefined ? "none" : typeof actual === "string" && ["const", "enum"].includes(error.keyword) ? `“${actual}”` : describe(actual);
    const field = error.instancePath.slice(1).replaceAll("/", ".") || (fact.split(".").at(-1) as string);
    if (text) return said(text, { got, field });
    const name = label(fact) ?? fact;
    return { message: value === undefined ? `${name} is absent` : `${name}${error.instancePath} ${error.message} (got ${got})` };
}

function severityOf(id: string, spec: RuleSpec, fallback: Severity): Exclude<Severity, "off"> {
    const severity = typeof spec.score === "number" && !spec.pinned ? levelOf(spec.score) : (spec.severity ?? fallback);
    if (severity === "off") throw new ConfigError(`rule ${id}: compiled while off`);
    return severity;
}

// Whether the document at `subject` fails its `when`; a page is its own URL.
type Guard = (facts: object, subject: string, site?: SiteFacts) => boolean;

// A `when` path read from the site document, as `site.role`, rather than one subject’s facts.
function isSitePath(path: string): boolean {
    return path.startsWith("site.") && !/^site\.(origins|hosts)\./.test(path);
}

// The `when` entries a site-wide guard reads.
function siteWhen(when: Record<string, unknown> | undefined): Record<string, unknown> {
    return Object.fromEntries(Object.entries(when ?? {}).filter(([path]) => isSitePath(path)));
}

// A `when` entry is a constant to equal, or a schema object the fact must satisfy.
function guard(id: string, when: Record<string, unknown> | undefined): Guard {
    const tests = Object.entries(when ?? {}).map(([path, expected]) => {
        const test = typeof expected === "object" && expected !== null ? ajv.compile(expected) : (actual: unknown) => actual === expected;
        return { path, expected, test };
    });
    return (facts, subject, site) => {
        for (const { path, expected, test } of tests) {
            const actual = get(isSitePath(path) ? { site } : facts, path);
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
        meta: { id, severity, scope: "page", facts: [fact], docs: spec.docs, fix: spec.fix, expect: spec.expect },
        check(page, site) {
            if (isSkipped(page, page.url.href, site)) return;
            if (get(page, root) === undefined) {
                log.debug({ rule: id, url: page.url.href, extractor: root }, "rule skipped");
                return;
            }
            const value = get(page, fact);
            if (validate(value)) return [];
            const error = validate.errors?.[0] as ErrorObject;
            return [{ rule: id, severity, scope: "page", url: page.url.href, group: page.group, ...message(fact, value, error, spec.message), value }];
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
        check(pages, group, site) {
            const byValue = new Map<string, string[]>();
            for (const page of pages) {
                if (isSkipped(page, page.url.href, site)) continue;
                const value = get(page, fact);
                if (typeof value !== "string") continue;
                byValue.set(value, [...(byValue.get(value) ?? []), page.url.href]);
            }
            const findings: Finding[] = [];
            for (const [value, urls] of byValue) {
                if (urls.length < 2) continue;
                log.debug({ rule: id, group, value, pages: urls.length }, "duplicate value");
                findings.push({ rule: id, severity, scope, url: urls[0] as string, group, ...(spec.message ? said(spec.message, { got: describe(value) }) : { message: `${label(fact) ?? fact} is shared by ${urls.length} pages (${describe(value)})` }), value, urls });
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
    log.debug({ rule: id, kind: subject.kind, when: when.length, site: Object.keys(siteWhen(spec.when)), ignored: Object.keys(spec.when ?? {}).length - when.length - Object.keys(siteWhen(spec.when)).length }, "subject rule compiled");
    const isSkipped = guard(id, Object.fromEntries(when.map(([path, expected]) => [path.slice(prefix.length), expected])));
    const isSiteSkipped = guard(id, siteWhen(spec.when));
    const needs = [...when.map(([path]) => path), ...(spec.hints ? [`${prefix}stack`] : [])].filter((path) => subjectPath(path)?.id !== subject.id);
    return {
        meta: { id, severity, scope: "site", facts: [fact, ...new Set(needs)], docs: spec.docs, fix: spec.fix, expect: spec.expect, ...(spec.linked === true && subject.kind === "hosts" && { linked: true }) },
        check(_pages, _group, site) {
            if (isSiteSkipped({}, "site", site)) return;
            const unjudged = new Set(spec.linked === true ? [] : (site?.linked ?? []));
            const judged = Object.entries(site?.[subject.kind] ?? {}).filter(([name, facts]) => facts[subject.id] !== undefined && !unjudged.has(name) && !isSkipped(facts, name) && !isWithheld(facts, subject.path, id, name));
            log.debug({ rule: id, subjects: judged.length, linked: spec.linked === true }, "subjects judged");
            return judged.length === 0
                ? undefined
                : judged.flatMap(([name, facts]) => {
                      const value = get(facts, subject.path);
                      if (validate(value)) return [];
                      const error = validate.errors?.[0] as ErrorObject;
                      const hint = hintFor(spec.hints, facts.stack);
                      if (hint) log.debug({ rule: id, subject: name, service: hint.service }, "service hint chosen");
                      return [{ rule: id, severity, scope: "site" as const, url: name, ...message(fact, value, error, spec.message), value, ...(hint && { hint: hint.text }) }];
                  });
        },
    };
}

// The hint for the first service the subject’s `stack` names, if the rule has one for it.
function hintFor(hints: Record<string, string> | undefined, stack: unknown): { service: string; text: string } | undefined {
    const names = Object.values((stack ?? {}) as Record<string, { name: string }>).map((entry) => entry.name);
    const service = names.find((name) => hints?.[name] !== undefined);
    return service && hints ? { service, text: hints[service] as string } : undefined;
}

// A built-in page rule honours `when` as a declarative one does; an aggregate one its `site.` paths.
function guarded(rule: Rule, when: Record<string, unknown> | undefined): Rule {
    const id = rule.meta.id;
    if (isPageRule(rule)) {
        const isSkipped = guard(id, when);
        return { ...rule, check: (page: Facts, site?: SiteFacts) => (isSkipped(page, page.url.href, site) ? undefined : rule.check(page, site)) };
    }
    const isSkipped = guard(id, siteWhen(when));
    return { ...rule, check: (pages, group, site) => (isSkipped({}, "site", site) ? undefined : rule.check(pages, group, site)) };
}

// Gives every finding its score: the spec’s number, else the rule’s own or the scale’s over the finding’s value, else the level’s base; a hand-written level pins it inside its band.
function scored(rule: Rule, spec: RuleSpec): Rule {
    const fixed = typeof spec.score === "number" ? (spec.pinned ? pin(spec.severity as Level, spec.score) : spec.score) : undefined;
    const scale = typeof spec.score === "object" ? spec.score : undefined;
    const level: Level = (spec.pinned ? spec.severity : rule.meta.severity) as Level;
    const meta = { ...rule.meta, score: fixed ?? (scale ? undefined : baseScore(level)), scale };
    const grade = (finding: Finding): Finding => {
        const measured = scale && typeof finding.value === "number" ? interpolate(scale, finding.value) : finding.score;
        const raw = fixed ?? measured ?? scoreOf(finding);
        const score = spec.pinned ? pin(level, raw) : raw;
        log.debug({ rule: rule.meta.id, url: finding.url, score, pinned: spec.pinned === true }, "finding scored");
        return { ...finding, score, severity: levelOf(score) };
    };
    const all = (found: Finding[] | undefined) => found?.map((finding) => grade(finding));
    return isPageRule(rule) ? { meta: { ...meta, scope: "page" }, check: (page: Facts, site?: SiteFacts) => all(rule.check(page, site)) } : { meta: { ...meta, scope: rule.meta.scope }, check: (pages: Facts[], group?: string, site?: SiteFacts) => all(rule.check(pages, group, site)) };
}

// A rule from its spec, every finding scored.
export function compileRule(id: string, spec: RuleSpec): Rule {
    return scored(compileUnscored(id, spec), spec);
}

// `fact` + `expect` is a page rule, `unique` an aggregate, an ID without `fact` a built-in handed its `expect`; else a config error.
function compileUnscored(id: string, spec: RuleSpec): Rule {
    if (spec.unique) return compileUnique(id, spec, spec.unique);
    const make = spec.fact ? undefined : ruleMaker(id);
    if (!spec.fact && (make || !spec.expect)) {
        if (!make) throw new ConfigError(`rule ${id}: needs fact and expect, or unique, or a built-in ID`);
        const rule = make(severityOf(id, spec, "warning"), spec.expect);
        // A ruleset entry’s `docs` and `fix` win over the built-in’s own.
        Object.assign(rule.meta, spec.docs && { docs: spec.docs }, spec.fix && { fix: spec.fix });
        return guarded(rule, spec.when);
    }
    if (!spec.fact || !spec.expect) throw new ConfigError(`rule ${id}: needs both fact and expect`);
    try {
        const subject = subjectPath(spec.fact);
        return subject ? compileSubject(id, spec, spec.fact, subject, ajv.compile(spec.expect)) : compilePage(id, spec, spec.fact, ajv.compile(spec.expect));
    } catch (error) {
        throw new ConfigError(`rule ${id}: expect ${error instanceof Error ? error.message : String(error)}`);
    }
}
