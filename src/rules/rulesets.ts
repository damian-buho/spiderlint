// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import picomatch from "picomatch";
import { parse } from "yaml";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { pluginPreset, pluginPresetNames, ruleMaker } from "../plugins/index.ts";
import { compileRule } from "./declarative.ts";
import type { Rule, RuleSpec, RulesetConfig, Severity } from "./types.ts";

const PRESETS = new URL("../../presets/", import.meta.url);
const PREFIX = "spiderlint:";
const ALL = "all";
const presetCache = new Map<string, RulesetConfig>();

// A plugin’s preset, else presets/<name>.yaml read once; undefined when no such preset ships.
function preset(name: string): RulesetConfig | undefined {
    if (name === ALL) return { description: "Every rule that ships or a loaded plugin adds", extends: presetNames().filter((other) => other !== ALL).map((other) => `${PREFIX}${other}`) };
    const plugged = pluginPreset(name);
    if (plugged) return plugged;
    if (!presetCache.has(name)) {
        try {
            const text = readFileSync(new URL(`${name}.yaml`, PRESETS), "utf8");
            presetCache.set(name, parse(text) as RulesetConfig);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`preset ${PREFIX}${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return presetCache.get(name);
}

// A bare name is the user's ruleset, else the bundled preset; the prefix forces the preset, and `all` is always every preset.
export function lookup(name: string, rulesets: Record<string, RulesetConfig>): RulesetConfig | undefined {
    if (name === ALL && Object.hasOwn(rulesets, ALL)) throw new ConfigError(`ruleset ${ALL}: reserved for every shipped rule; rename it`);
    return name.startsWith(PREFIX) ? preset(name.slice(PREFIX.length)) : (rulesets[name] ?? preset(name));
}

// Every preset that ships or a plugin adds, by bare name.
export function presetNames(): string[] {
    const files = readdirSync(PRESETS).filter((file) => file.endsWith(".yaml")).map((file) => file.slice(0, -".yaml".length));
    return [...files, ALL, ...pluginPresetNames()].toSorted((a, b) => a.localeCompare(b));
}

// Flattens `extends` depth-first; later entries override earlier ones per rule ID, `expect` keyword by keyword.
export function resolveRuleset(name: string, rulesets: Record<string, RulesetConfig>, seen: string[] = []): Record<string, RuleSpec> {
    if (seen.includes(name)) throw new ConfigError(`ruleset ${name}: extends itself through ${seen.join(" → ")}`);
    const config = lookup(name, rulesets);
    if (!config) return selectRules(name, rulesets, seen);
    const merged: Record<string, RuleSpec> = {};
    const parents = config.extends ?? [];
    for (const parent of parents) Object.assign(merged, resolveRuleset(parent, rulesets, [...seen, name]));
    const own = Object.entries(config.rules ?? {});
    for (const [id, entry] of own) {
        if (typeof entry === "string" && merged[id] === undefined && ruleMaker(id) === undefined) throw new ConfigError(`ruleset ${name}: rule ${id} sets ${entry} but is not defined`);
        const spec = typeof entry === "string" ? { severity: entry } : entry;
        // A new `expect` drops the inherited sentence, which may state the old bounds.
        const expect = spec.expect && { expect: { ...merged[id]?.expect, ...spec.expect }, message: spec.message };
        merged[id] = { ...merged[id], ...spec, ...expect, ...(config.when && { when: { ...config.when, ...merged[id]?.when, ...spec.when } }) };
    }
    log.debug({ ruleset: name, rules: Object.keys(merged).length }, "ruleset resolved");
    return merged;
}

// A name no ruleset carries, read as a rule ID or glob over every shipped rule.
function selectRules(pattern: string, rulesets: Record<string, RulesetConfig>, seen: string[]): Record<string, RuleSpec> {
    const shipped = Object.entries(resolveRuleset(`${PREFIX}${ALL}`, rulesets, [...seen, pattern]));
    const picked = Object.fromEntries(shipped.filter(([id]) => isRuleMatch(id, pattern)));
    log.debug({ pattern, rules: Object.keys(picked) }, "ruleset name read as rule IDs");
    if (Object.keys(picked).length === 0) throw new ConfigError(`ruleset ${pattern}: not defined, and no rule ID matches it`);
    return picked;
}

// Whether a rule ID is `pattern` or matches it as a glob (`lighthouse/*`).
export function isRuleMatch(id: string, pattern: string): boolean {
    return id === pattern || picomatch.isMatch(id, pattern);
}

// Every rule ID the named rulesets define, `off` ones included.
export function ruleIds(names: string[], rulesets: Record<string, RulesetConfig>): Set<string> {
    return new Set(names.flatMap((name) => Object.keys(resolveRuleset(name, rulesets))));
}

// Union of the named rulesets, compiled; `off` rules — including `--exclude-rules` and a
// `--error`/`--warning`/`--info` override landing on `off` — are dropped (AGENTS.md ## Rules).
export function compileRulesets(names: string[], rulesets: Record<string, RulesetConfig>, excludeRules: Set<string> = new Set(), overrides: Record<string, Exclude<Severity, "off">> = {}): Rule[] {
    const specs: Record<string, RuleSpec> = {};
    for (const name of names) Object.assign(specs, resolveRuleset(name, rulesets));
    const rules: Rule[] = [];
    for (const [id, spec] of Object.entries(specs)) {
        const isExcluded = [...excludeRules].some((pattern) => isRuleMatch(id, pattern));
        const override = overrides[id] ?? Object.entries(overrides).find(([pattern]) => isRuleMatch(id, pattern))?.[1];
        const severity: Severity | undefined = isExcluded ? "off" : (override ?? spec.severity);
        if (severity === "off") {
            log.debug({ rule: id }, "rule off");
            continue;
        }
        rules.push(compileRule(id, severity === spec.severity ? spec : { ...spec, severity }));
    }
    return rules;
}
