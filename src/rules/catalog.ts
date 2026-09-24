// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Paint, Style } from "../color.ts";
import type { Config } from "../config/index.ts";
import { groupsOf } from "../index.ts";
import { log } from "../logger.ts";
import { compileRule } from "./declarative.ts";
import { compileRulesets, lookup, presetNames, resolveRuleset } from "./rulesets.ts";
import type { Scope, Severity } from "./types.ts";

const PREFIX = "spiderlint:";
const TONE: Record<string, Style> = { error: "red", warning: "yellow", info: "blue", off: "dim" };

export interface RuleInfo {
    id: string;
    severity: string;
    preset: Severity;
    scope: Scope;
    rulesets: string[];
    facts: string[];
    docs?: string;
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
        const compiled = compileRulesets(rules, config.rulesets, new Set(config.disabledRules), config.overrides);
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
export function listRules(config: Config, names: string[]): RuleInfo[] {
    const severities = running(config);
    const all = sources(config);
    const homes = new Map<string, string[]>();
    for (const name of all) {
        const own = Object.keys(lookup(name, config.rulesets)?.rules ?? {});
        for (const id of own) homes.set(id, [...(homes.get(id) ?? []), bare(name)]);
    }
    const specs = Object.assign({}, ...(names.length > 0 ? names : all).map((name) => resolveRuleset(name, config.rulesets))) as ReturnType<typeof resolveRuleset>;
    log.debug({ rulesets: names, rules: Object.keys(specs).length }, "catalog rules resolved");
    return Object.entries(specs).toSorted(([a], [b]) => a.localeCompare(b)).map(([id, spec]) => {
        const preset = spec.severity ?? "warning";
        const { meta } = compileRule(id, { ...spec, severity: preset === "off" ? "warning" : preset });
        return { id, severity: [...(severities.get(id) ?? ["off"])].join("/"), preset, scope: meta.scope, rulesets: homes.get(id) ?? [], facts: meta.facts, docs: meta.docs };
    });
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
    return rows.map((row, index) => row.map((cell, column) => {
        const padded = column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0);
        const tone = index === 0 ? "bold" : style(index, column, cell);
        return tone ? paint(tone, padded) : padded;
    }).join("  ").trimEnd()).join("\n");
}

export function formatRules(rules: RuleInfo[], paint: Paint): string {
    const rows = [["RULE", "SEVERITY", "SCOPE", "RULESET", "DOCS"], ...rules.map((rule) => [rule.id, rule.severity, rule.scope, rule.rulesets.join(", "), rule.docs ?? ""])];
    return table(rows, paint, (_row, column, cell) => (column === 1 ? TONE[cell.split("/", 1)[0] ?? ""] : column === 4 ? "dim" : undefined));
}

export function formatPresets(presets: PresetInfo[], paint: Paint): string {
    const rows = [["PRESET", "RULES", "USED", "DESCRIPTION"], ...presets.map((preset) => [preset.name, String(preset.rules), preset.used ? "yes" : "no", preset.description])];
    return table(rows, paint, (_row, column, cell) => (column === 2 ? (cell === "yes" ? "green" : "dim") : undefined));
}
