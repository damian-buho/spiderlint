// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { builtin } from "./builtin.ts";
import { compileRule } from "./declarative.ts";
import type { Rule, RuleSpec, RulesetConfig, Severity } from "./types.ts";

const PRESETS = new URL("../../presets/", import.meta.url);
const PREFIX = "spiderlint:";
const presetCache = new Map<string, RulesetConfig>();

// presets/<name>.yaml, read once; undefined when no such preset ships.
function preset(name: string): RulesetConfig | undefined {
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

// A bare name is the user's ruleset, else the bundled preset; the prefix forces the preset.
export function lookup(name: string, rulesets: Record<string, RulesetConfig>): RulesetConfig | undefined {
    return name.startsWith(PREFIX) ? preset(name.slice(PREFIX.length)) : (rulesets[name] ?? preset(name));
}

// Every preset that ships, by bare name.
export function presetNames(): string[] {
    return readdirSync(PRESETS).filter((file) => file.endsWith(".yaml")).map((file) => file.slice(0, -".yaml".length)).toSorted((a, b) => a.localeCompare(b));
}

// Flattens `extends` depth-first; later entries override earlier ones per rule ID.
export function resolveRuleset(name: string, rulesets: Record<string, RulesetConfig>, seen: string[] = []): Record<string, RuleSpec> {
    if (seen.includes(name)) throw new ConfigError(`ruleset ${name}: extends itself through ${seen.join(" → ")}`);
    const config = lookup(name, rulesets);
    if (!config) throw new ConfigError(`ruleset ${name}: not defined`);
    const merged: Record<string, RuleSpec> = {};
    const parents = config.extends ?? [];
    for (const parent of parents) Object.assign(merged, resolveRuleset(parent, rulesets, [...seen, name]));
    const own = Object.entries(config.rules ?? {});
    for (const [id, entry] of own) {
        if (typeof entry === "string" && merged[id] === undefined && builtin[id] === undefined) throw new ConfigError(`ruleset ${name}: rule ${id} sets ${entry} but is not defined`);
        const spec = typeof entry === "string" ? { severity: entry } : entry;
        merged[id] = { ...merged[id], ...spec, ...(config.when && { when: { ...config.when, ...merged[id]?.when, ...spec.when } }) };
    }
    log.debug({ ruleset: name, rules: Object.keys(merged).length }, "ruleset resolved");
    return merged;
}

// Every rule ID the named rulesets define, `off` ones included.
export function ruleIds(names: string[], rulesets: Record<string, RulesetConfig>): Set<string> {
    return new Set(names.flatMap((name) => Object.keys(resolveRuleset(name, rulesets))));
}

// Union of the named rulesets, compiled; `off` rules — including `--disabled-rules` and a
// `--error`/`--warning`/`--info` override landing on `off` — are dropped (AGENTS.md ## Rules).
export function compileRulesets(names: string[], rulesets: Record<string, RulesetConfig>, disabledRules: Set<string> = new Set(), overrides: Record<string, Exclude<Severity, "off">> = {}): Rule[] {
    const specs: Record<string, RuleSpec> = {};
    for (const name of names) Object.assign(specs, resolveRuleset(name, rulesets));
    const rules: Rule[] = [];
    for (const [id, spec] of Object.entries(specs)) {
        const severity: Severity | undefined = disabledRules.has(id) ? "off" : (overrides[id] ?? spec.severity);
        if (severity === "off") {
            log.debug({ rule: id }, "rule off");
            continue;
        }
        rules.push(compileRule(id, severity === spec.severity ? spec : { ...spec, severity }));
    }
    return rules;
}
