// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { ConfigError } from "../config/index.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { builtin } from "../rules/builtin.ts";
import { presetNames } from "../rules/rulesets.ts";
import type { Make, Rule, RulesetConfig } from "../rules/types.ts";
import htmlValidate from "./html-validate.ts";
import type { Extractor, Plugin } from "./types.ts";

const plugins: Plugin[] = [htmlValidate];
const loaded = new Set(plugins.map((plugin) => plugin.name));

// A TypeScript rule by ID: the core’s, else a plugin’s.
export function ruleMaker(id: string): Make | undefined {
    return builtin[id] ?? plugins.find((plugin) => plugin.rules?.[id])?.rules?.[id];
}

// A preset a plugin ships.
export function pluginPreset(name: string): RulesetConfig | undefined {
    return plugins.find((plugin) => plugin.presets?.[name])?.presets?.[name];
}

export function pluginPresetNames(): string[] {
    return plugins.flatMap((plugin) => Object.keys(plugin.presets ?? {}));
}

function allExtractors(): Extractor[] {
    return plugins.flatMap((plugin) => plugin.extractors ?? []);
}

// Whether reading `fact` needs a rendered page: `browser.*`, or the key of a browser-mode extractor.
export function isBrowserFact(fact: string): boolean {
    const root = fact.split(".", 1)[0];
    return root === "browser" || allExtractors().some((extractor) => extractor.mode === "browser" && extractor.id === root);
}

// Adds a plugin; a rule, preset or extractor name already taken is a config error.
function register(plugin: Plugin): void {
    const taken = new Set(allExtractors().map((extractor) => extractor.id));
    const shipped = new Set(presetNames());
    const rules = Object.keys(plugin.rules ?? {}).filter((id) => ruleMaker(id));
    const presets = Object.keys(plugin.presets ?? {}).filter((name) => shipped.has(name));
    const extractors = (plugin.extractors ?? []).map((extractor) => extractor.id).filter((id) => taken.has(id));
    const clash = [...rules, ...presets, ...extractors];
    if (clash.length > 0) throw new ConfigError(`plugin ${plugin.name}: ${clash.join(", ")} already defined`);
    plugins.push(plugin);
    log.debug({ plugin: plugin.name, rules: Object.keys(plugin.rules ?? {}).length, presets: Object.keys(plugin.presets ?? {}), extractors: plugin.extractors?.length ?? 0 }, "plugin registered");
}

// Imports each named plugin once: a path from the working directory, else a package installed beside spiderlint.
export async function loadPlugins(names: string[]): Promise<void> {
    for (const name of names) {
        if (loaded.has(name)) {
            log.debug({ plugin: name }, "plugin bundled or loaded");
            continue;
        }
        const specifier = /^\.{0,2}\//.test(name) ? pathToFileURL(path.resolve(name)).href : name;
        let module: { default?: Plugin };
        try {
            module = (await import(specifier)) as { default?: Plugin };
        } catch (error) {
            throw new ConfigError(`plugin ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (typeof module.default?.name !== "string") throw new ConfigError(`plugin ${name}: its default export has no name`);
        if (!loaded.has(module.default.name)) register(module.default);
        loaded.add(name).add(module.default.name);
        log.info({ plugin: module.default.name, specifier }, "plugin loaded");
    }
}

// Extractors whose ID is the first key of a fact some rule reads.
export function extractorsFor(rules: Rule[]): Extractor[] {
    const roots = new Set(rules.flatMap((rule) => rule.meta.facts.map((fact) => fact.split(".", 1)[0])));
    const active = allExtractors().filter((extractor) => roots.has(extractor.id));
    log.debug({ extractors: active.map((extractor) => extractor.id), roots: roots.size }, "extractors chosen");
    return active;
}

// Each extractor’s facts under its ID; one that throws, or needs a `live` page it lacks, leaves its key absent, so its rules skip.
export async function extract(page: Facts, body: string, active: Extractor[], live?: Page): Promise<void> {
    for (const extractor of active) {
        if (!live && extractor.mode === "browser") {
            log.debug({ url: page.url.href, extractor: extractor.id }, "extractor needs a rendered page");
            continue;
        }
        try {
            const value = await extractor.extract(page, body, live);
            if (value !== undefined) page[extractor.id] = value;
        } catch (error) {
            log.warn({ url: page.url.href, extractor: extractor.id, error: error instanceof Error ? error.message : String(error) }, "extractor failed");
        }
    }
}
