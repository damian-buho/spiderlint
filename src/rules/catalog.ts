// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Paint, Style } from "../color.ts";
import type { Config } from "../config/index.ts";
import { groupsOf } from "../index.ts";
import { log } from "../logger.ts";
import { ConfigError } from "../config/index.ts";
import { ruleMaker } from "../plugins/index.ts";
import { compileRule } from "./declarative.ts";
import { fixFor } from "./fix.ts";
import { compileRulesets, lookup, presetNames, resolveRuleset } from "./rulesets.ts";
import type { RuleMeta, RuleSpec, Scope, Severity } from "./types.ts";

const PREFIX = "spiderlint:";
const TONE: Record<string, Style> = { error: "red", warning: "yellow", info: "blue", hint: "dim", off: "dim" };

export interface RuleInfo {
    id: string;
    severity: string;
    preset: Severity;
    // The static score, or the points a dynamic one follows.
    score: string;
    scope: Scope;
    rulesets: string[];
    facts: string[];
    docs?: string;
}

export interface RuleExplanation extends RuleInfo {
    kind: "declarative" | "unique" | "built-in";
    expect?: Record<string, unknown>;
    when?: Record<string, unknown>;
    message?: string;
    fix?: string;
}

export interface PresetInfo {
    name: string;
    description: string;
    rules: number;
    extends: string[];
    used: boolean;
}

function bare(name: string): string {
    return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
}

// The user's rulesets, then every shipped preset.
function sources(config: Config): string[] {
    return [...Object.keys(config.rulesets), ...presetNames().map((name) => `${PREFIX}${name}`)];
}

// Severities each rule runs at across the configured groups, flags applied.
function running(config: Config): Map<string, Set<string>> {
    const severities = new Map<string, Set<string>>();
    const groups = Object.entries(groupsOf(config));
    for (const [group, { rules }] of groups) {
        const compiled = compileRulesets(rules, config.rulesets, new Set(config.excludeRules), config.overrides);
        log.debug({ group, rulesets: rules, rules: compiled.length }, "catalog group compiled");
        for (const { meta } of compiled) severities.set(meta.id, (severities.get(meta.id) ?? new Set()).add(meta.severity));
    }
    return severities;
}

// A ruleset and every ruleset it extends, by bare name.
function closure(name: string, rulesets: Config["rulesets"]): string[] {
    return [bare(name), ...(lookup(name, rulesets)?.extends ?? []).flatMap((parent) => closure(parent, rulesets))];
}

// Every rule the named rulesets resolve to, or every rule any ruleset defines.
export function listRules(config: Config, names: string[]): RuleExplanation[] {
    const severities = running(config);
    const all = sources(config);
    const homes = new Map<string, string[]>();
    for (const name of all) {
        const own = Object.keys(lookup(name, config.rulesets)?.rules ?? {});
        for (const id of own) homes.set(id, [...(homes.get(id) ?? []), bare(name)]);
    }
    const specs = Object.assign({}, ...(names.length > 0 ? names : all).map((name) => resolveRuleset(name, config.rulesets))) as ReturnType<typeof resolveRuleset>;
    log.debug({ rulesets: names, rules: Object.keys(specs).length }, "catalog rules resolved");
    return Object.entries(specs)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([id, spec]) => describeRule(id, spec, severities, homes.get(id) ?? []));
}

// A rule’s score as `5.0`, or the scale a dynamic one follows as `0 days → 6.8, 2 → 5.2`.
function scoreText({ score, scale }: Pick<RuleMeta, "score" | "scale">): string {
    return scale ? `dynamic: ${scale.map(([value, points]) => `${value} → ${points.toFixed(1)}`).join(", ")}` : (score ?? 0).toFixed(1);
}

// One rule’s catalog row, compiled at its preset severity so an `off` rule still has a meta.
function describeRule(id: string, spec: RuleSpec, severities: Map<string, Set<string>>, rulesets: string[]): RuleExplanation {
    const preset = spec.severity ?? "warning";
    const { meta } = compileRule(id, { ...spec, severity: preset === "off" ? "warning" : preset });
    const kind = spec.unique ? "unique" : spec.fact ? "declarative" : "built-in";
    return { id, severity: [...(severities.get(id) ?? ["off"])].join("/"), preset, score: scoreText(meta), scope: meta.scope, rulesets, facts: meta.facts, docs: meta.docs, kind, expect: spec.expect, when: spec.when, message: spec.message, fix: meta.fix };
}

// Everything known about one rule; a rule no ruleset carries and no plugin makes is a config error.
export function explainRule(config: Config, id: string): RuleExplanation {
    const found = listRules(config, []).find((rule) => rule.id === id);
    log.debug({ rule: id, found: found !== undefined, maker: ruleMaker(id) !== undefined }, "rule explained");
    if (found) return found;
    if (ruleMaker(id)) return describeRule(id, { severity: "off" }, running(config), []);
    throw new ConfigError(`rule ${id}: not defined (see spiderlint list-rules)`);
}

// Every shipped preset, with whether a configured group runs it.
export function listPresets(config: Config): PresetInfo[] {
    const used = new Set(Object.values(groupsOf(config)).flatMap(({ rules }) => rules.flatMap((name) => closure(name, config.rulesets))));
    return presetNames().map((name) => {
        const preset = lookup(`${PREFIX}${name}`, config.rulesets);
        return { name, description: preset?.description ?? "", rules: Object.keys(resolveRuleset(`${PREFIX}${name}`, config.rulesets)).length, extends: (preset?.extends ?? []).map((parent) => bare(parent)), used: used.has(name) };
    });
}

// Left-aligned columns sized to their widest cell; the header row bold.
function table(rows: string[][], paint: Paint, style: (row: number, column: number, cell: string) => Style | undefined): string {
    const widths = rows[0]?.map((_cell, column) => Math.max(...rows.map((row) => (row[column] ?? "").length))) ?? [];
    return rows
        .map((row, index) =>
            row
                .map((cell, column) => {
                    const padded = column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0);
                    const tone = index === 0 ? "bold" : style(index, column, cell);
                    return tone ? paint(tone, padded) : padded;
                })
                .join("  ")
                .trimEnd(),
        )
        .join("\n");
}

export function formatRules(rules: RuleInfo[], paint: Paint): string {
    const rows = [["RULE", "SEVERITY", "SCORE", "SCOPE", "RULESET", "DOCS"], ...rules.map((rule) => [rule.id, rule.severity, rule.score.split(":", 1)[0] as string, rule.scope, rule.rulesets.join(", "), rule.docs ?? ""])];
    return table(rows, paint, (_row, column, cell) => (column === 1 ? TONE[cell.split("/", 1)[0] ?? ""] : column === 5 ? "dim" : undefined));
}

// One labelled line per field the rule carries; schemas as compact JSON.
export function formatExplanation(rule: RuleExplanation, paint: Paint): string {
    const rows: [string, string | undefined][] = [
        ["severity", `${rule.severity} (preset ${rule.preset})`],
        ["score", rule.score],
        ["scope", rule.scope],
        ["kind", rule.kind],
        ["rulesets", rule.rulesets.join(", ") || undefined],
        ["reads", rule.facts.join(", ")],
        ["expect", rule.expect && JSON.stringify(rule.expect)],
        ["when", rule.when && JSON.stringify(rule.when)],
        ["message", rule.message],
        ["fix", rule.fix && fixFor(rule.fix)],
        ["docs", rule.docs],
    ];
    const lines = rows.filter((row): row is [string, string] => row[1] !== undefined).map(([label, value]) => `${paint("dim", label.padEnd(9))}${value}`);
    return [paint("bold", rule.id), ...lines].join("\n");
}

export function formatPresets(presets: PresetInfo[], paint: Paint): string {
    const rows = [["PRESET", "RULES", "USED", "DESCRIPTION"], ...presets.map((preset) => [preset.name, String(preset.rules), preset.used ? "yes" : "no", preset.description])];
    return table(rows, paint, (_row, column, cell) => (column === 2 ? (cell === "yes" ? "green" : "dim") : undefined));
}
