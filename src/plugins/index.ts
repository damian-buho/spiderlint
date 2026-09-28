// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import path from "node:path";
import { pathToFileURL } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Page } from "playwright";
import { loadedDigest } from "../crawl/browser.ts";
import { VERSION } from "../agent.ts";
import { ExtractorCache } from "../cache/extractors.ts";
import { ConfigError, type Config } from "../config/index.ts";
import { CORE_KEYS, describe } from "../config/schema.ts";
import { subjectPath } from "../facts/sites.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { progressStep } from "../progress.ts";
import { inSpan, recordExtractor } from "../telemetry.ts";
import { builtin } from "../rules/builtin.ts";
import report from "../report/index.ts";
import { presetNames } from "../rules/rulesets.ts";
import type { Make, Rule, RulesetConfig } from "../rules/types.ts";
import axe from "./axe.ts";
import cookies from "./cookies.ts";
import dns from "./dns.ts";
import feeds from "./feeds.ts";
import htmlValidate from "./html-validate.ts";
import htmlhint from "./htmlhint.ts";
import images from "./images.ts";
import keyboard from "./keyboard.ts";
import lighthouse from "./lighthouse.ts";
import linkText from "./link-text.ts";
import list from "./list.ts";
import live from "./live.ts";
import icons from "./icons.ts";
import manifest from "./manifest.ts";
import markup from "./markup.ts";
import origin from "./origin.ts";
import structuredData from "./structured-data.ts";
import tlsProbe from "./tls-probe.ts";
import trackers from "./trackers.ts";
import type { Extractor, Formatter, PageContext, Plugin, ResourceExtractor, SiteExtractor, Source } from "./types.ts";
import wellKnown from "./well-known.ts";

const plugins: Plugin[] = [report, htmlValidate, htmlhint, axe, keyboard, live, lighthouse, origin, dns, tlsProbe, cookies, images, wellKnown, feeds, structuredData, manifest, icons, linkText, markup, trackers, list];
// Milliseconds before a source that has not answered aborts the run.
const SOURCE_MS = 60_000;
const loaded = new Set(plugins.map((plugin) => plugin.name));
const bundled = plugins.flatMap((plugin) => [...(plugin.extractors ?? []), ...(plugin.resources ?? []), ...(plugin.sites ?? [])]);
for (const extractor of bundled) extractor.version ??= VERSION;
const ajv = new Ajv2020({ strictTypes: false, allErrors: true, useDefaults: true });
// Each plugin’s validated settings, by plugin name.
const settings = new Map<string, unknown>();

// `raw` validated against the plugin’s schema, its defaults filled in; a violation names its path.
function settle(plugin: Plugin, raw: unknown = {}): unknown {
    if (!plugin.settings) return undefined;
    const value = structuredClone(raw);
    const validate = ajv.compile(plugin.settings);
    if (!validate(value)) throw new ConfigError((validate.errors ?? []).map((error) => describe(error, `org.spiderlint/${plugin.name}`)).join("; "));
    return value;
}

// Settles every plugin’s key of `raw`; a key no loaded plugin claims is unknown.
function configure(raw: Record<string, unknown>): void {
    const unclaimed = Object.keys(raw).filter((key) => plugins.every((plugin) => plugin.name !== key || !plugin.settings));
    if (unclaimed.length > 0) throw new ConfigError(unclaimed.map((key) => `org.spiderlint: unknown key "${key}"`).join("; "));
    settings.clear();
    for (const plugin of plugins) if (plugin.settings) settings.set(plugin.name, settle(plugin, raw[plugin.name]));
    log.debug({ plugins: settings.keys().toArray(), set: Object.keys(raw) }, "plugin settings validated");
}

// A TypeScript rule by ID: the core’s, else a plugin’s, handed its plugin’s settings.
export function ruleMaker(id: string): Make | undefined {
    const plugin = plugins.find((candidate) => candidate.rules?.[id]);
    const make = plugin?.rules?.[id];
    return builtin[id] ?? (plugin && make && ((severity) => make(severity, settings.has(plugin.name) ? settings.get(plugin.name) : settle(plugin))));
}

// A preset a plugin ships.
export function pluginPreset(name: string): RulesetConfig | undefined {
    return plugins.find((plugin) => plugin.presets?.[name])?.presets?.[name];
}

export function pluginPresetNames(): string[] {
    return plugins.flatMap((plugin) => Object.keys(plugin.presets ?? {}));
}

// A formatter by format name, bundled or a plugin’s.
export function formatter(name: string): Formatter | undefined {
    return plugins.find((plugin) => plugin.formatters?.[name])?.formatters?.[name];
}

// Every format name, the bundled ones first.
export function formatNames(): string[] {
    return [...plugins.flatMap((plugin) => Object.keys(plugin.formatters ?? {}))];
}

function allSources(): Source[] {
    return plugins.flatMap((plugin) => plugin.sources ?? []);
}

function allExtractors(): Extractor[] {
    return plugins.flatMap((plugin) => plugin.extractors ?? []);
}

function allSiteExtractors(): SiteExtractor[] {
    return plugins.flatMap((plugin) => plugin.sites ?? []);
}

function allResourceExtractors(): ResourceExtractor[] {
    return plugins.flatMap((plugin) => plugin.resources ?? []);
}

// Whether reading `fact` needs a rendered page: `browser.*`, or the key of a browser-mode extractor.
export function isBrowserFact(fact: string): boolean {
    const root = fact.split(".", 1)[0];
    return root === "browser" || allExtractors().some((extractor) => extractor.mode === "browser" && extractor.id === root);
}

// Whether reading `fact` needs an expensive extractor, whose facts only the group’s sample carries.
export function isSampledFact(fact: string): boolean {
    const root = fact.split(".", 1)[0];
    return allExtractors().some((extractor) => extractor.cost === "expensive" && extractor.id === root);
}

// Adds a plugin; a rule, preset or extractor name already taken is a config error.
function register(plugin: Plugin): void {
    const taken = new Set(allExtractors().map((extractor) => extractor.id));
    const shipped = new Set(presetNames());
    const rules = Object.keys(plugin.rules ?? {}).filter((id) => ruleMaker(id));
    const presets = Object.keys(plugin.presets ?? {}).filter((name) => shipped.has(name));
    const extractors = (plugin.extractors ?? []).map((extractor) => extractor.id).filter((id) => taken.has(id));
    const sites = (plugin.sites ?? []).filter((site) => allSiteExtractors().some((other) => other.id === site.id && other.per === site.per)).map((site) => `site.${site.per}s.*.${site.id}`);
    const resources = (plugin.resources ?? []).filter((resource) => allResourceExtractors().some((other) => other.id === resource.id)).map((resource) => `resources.${resource.id}`);
    const formatters = Object.keys(plugin.formatters ?? {}).filter((name) => formatNames().includes(name)).map((name) => `format ${name}`);
    const sources = (plugin.sources ?? []).filter((source) => allSources().some((other) => other.id === source.id)).map((source) => `source ${source.id}`);
    const keys = plugin.settings && CORE_KEYS.has(plugin.name) ? [`settings key ${plugin.name}`] : [];
    const clash = [...rules, ...presets, ...extractors, ...sites, ...resources, ...formatters, ...sources, ...keys];
    if (clash.length > 0) throw new ConfigError(`plugin ${plugin.name}: ${clash.join(", ")} already defined`);
    plugins.push(plugin);
    log.debug({ plugin: plugin.name, rules: Object.keys(plugin.rules ?? {}).length, presets: Object.keys(plugin.presets ?? {}), extractors: plugin.extractors?.length ?? 0, sites: plugin.sites?.length ?? 0, resources: plugin.resources?.length ?? 0, formatters: Object.keys(plugin.formatters ?? {}), sources: (plugin.sources ?? []).map((source) => source.id) }, "plugin registered");
}

// Imports each named plugin once: a path from the working directory, else a package installed beside spiderlint; then settles every plugin’s settings from `raw`.
export async function loadPlugins(names: string[], raw: Record<string, unknown> = {}): Promise<void> {
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
    configure(raw);
}

// Seeds with each `sources` entry’s URLs appended; one source that does not follow makes them the whole frontier.
export async function withSources(config: Config): Promise<Config> {
    let { seeds, follow } = config;
    for (const entry of config.sources) {
        const [id = "", ...rest] = entry.split(":");
        const argument = rest.join(":");
        const source = allSources().find((candidate) => candidate.id === id);
        if (!source) throw new ConfigError(`source ${id}: unknown (known: ${allSources().map((candidate) => candidate.id).join(", ")})`);
        let urls: string[];
        try {
            urls = await source.urls(argument, AbortSignal.timeout(SOURCE_MS));
        } catch (error) {
            throw new ConfigError(`source ${entry}: ${error instanceof Error ? error.message : String(error)}`);
        }
        seeds = [...seeds, ...urls];
        follow &&= source.follow !== false;
        log.info({ source: id, argument, urls: urls.length, follow }, "source read");
    }
    return { ...config, seeds: [...new Set(seeds)], follow };
}

// Extractors whose ID is the first key of a fact some rule reads.
export function extractorsFor(rules: Rule[]): Extractor[] {
    const roots = new Set(rules.flatMap((rule) => rule.meta.facts.map((fact) => fact.split(".", 1)[0])));
    const active = allExtractors().filter((extractor) => roots.has(extractor.id));
    log.debug({ extractors: active.map((extractor) => extractor.id), roots: roots.size }, "extractors chosen");
    return active;
}

// Site extractors whose ID sits under `site.origins.*` or `site.hosts.*` in a fact some rule reads.
export function siteExtractorsFor(rules: Rule[]): SiteExtractor[] {
    const read = new Set(rules.flatMap((rule) => rule.meta.facts.flatMap((fact) => {
        const subject = subjectPath(fact);
        return subject ? [`${subject.kind}\t${subject.id}`] : [];
    })));
    const active = plugins.flatMap((plugin) => (plugin.sites ?? []).filter((extractor) => read.has(`${extractor.per}s\t${extractor.id}`)).map((extractor) => (settings.has(plugin.name) ? { ...extractor, settings: settings.get(plugin.name) } : extractor)));
    log.debug({ extractors: active.map((extractor) => extractor.id), read: read.size }, "site extractors chosen");
    return active;
}

// IDs of the `per: host` site extractors a `linked` rule reads, which then also run on linked hosts.
export function linkedSiteExtractors(rules: Rule[]): Set<string> {
    const ids = new Set(rules.filter((rule) => rule.meta.linked).flatMap((rule) => rule.meta.facts.flatMap((fact) => {
        const subject = subjectPath(fact);
        return subject?.kind === "hosts" ? [subject.id] : [];
    })));
    log.debug({ extractors: [...ids] }, "site extractors judging linked hosts");
    return ids;
}

// Resource extractors whose ID is the second key of a `resources.<id>` fact some rule reads.
export function resourceExtractorsFor(rules: Rule[]): ResourceExtractor[] {
    const read = new Set(rules.flatMap((rule) => rule.meta.facts.flatMap((fact) => {
        const [root, id] = fact.split(".", 2);
        return root === "resources" && id ? [id] : [];
    })));
    const active = allResourceExtractors().filter((extractor) => read.has(extractor.id));
    log.debug({ extractors: active.map((extractor) => extractor.id), read: read.size }, "resource extractors chosen");
    return active;
}

// What keys `extractor` beyond the body: its `inputs` and, rendered, the browser; undefined when one is unknown.
function inputsOf(extractor: Extractor, page: Facts, live?: Page): string | undefined {
    const browser = live?.context().browser();
    const parts = extractor.mode === "browser" ? [browser ? `${browser.browserType().name()} ${browser.version()}` : undefined] : [];
    const inputs = extractor.inputs ?? [];
    for (const input of inputs) parts.push(input === "resources" ? live && loadedDigest(live) : [page.http.headers.link ?? ""].flat().join(", "));
    return parts.includes(undefined) ? undefined : parts.join("\0");
}

// Each extractor’s facts under its ID, through `cache`, returning the IDs that added some; one that throws, or needs a `live` page it lacks, adds nothing.
export async function extract(page: Facts, body: string, active: Extractor[], cache: ExtractorCache, live?: Page, context?: PageContext): Promise<string[]> {
    const kind = `${page.http["content-type"]}${page.http.size.truncated ? " truncated" : ""}`;
    const added: string[] = [];
    for (const extractor of active) {
        if (!live && extractor.mode === "browser") {
            log.debug({ url: page.url.href, extractor: extractor.id }, "extractor needs a rendered page");
            continue;
        }
        try {
            progressStep(page.url.href, extractor.id);
            const running = performance.now();
            const inputs = inputsOf(extractor, page, live);
            if (inputs === undefined) log.debug({ url: page.url.href, extractor: extractor.id, inputs: extractor.inputs }, "extractor inputs unknown, run uncached");
            const keyed = inputs === undefined ? { ...extractor, cached: false as const } : extractor;
            const value = await inSpan(`extract ${extractor.id}`, { "spiderlint.extractor": extractor.id, "url.full": page.url.href }, async () => cache.run(keyed, page.url.href, inputs ? `${kind}\0${inputs}` : kind, body, () => extractor.extract(page, body, live, context)));
            const ms = Math.round(performance.now() - running);
            recordExtractor(extractor.id, ms);
            log.debug({ url: page.url.href, extractor: extractor.id, ms, isEmpty: value === undefined }, "extractor ran");
            if (value === undefined) continue;
            page[extractor.id] = value;
            added.push(extractor.id);
        } catch (error) {
            log.warn({ url: page.url.href, extractor: extractor.id, error: error instanceof Error ? error.message : String(error) }, "extractor failed");
        }
    }
    return added;
}
