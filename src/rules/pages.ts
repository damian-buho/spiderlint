// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { layered } from "../config/index.ts";
import type { Translator } from "../i18n.ts";
import { log } from "../logger.ts";
import { listRules, listPresets, type RuleExplanation } from "./catalog.ts";
import { fixFor } from "./fix.ts";

export const PAGE_FORMATS = ["yaml", "markdown"];

// Every shipped rule, read with no user config so the catalog is the same on every machine.
export function shippedCatalog(): RuleExplanation[] {
    return listRules(layered([]), []);
}

// A rule’s fixes in order, placeholders shown as `<host>`.
function fixes(rule: RuleExplanation): string[] {
    return [rule.fix, ...(rule.extra ?? [])].filter((fix): fix is string => fix !== undefined).map((fix) => fixFor(fix));
}

// The catalog as a projectfile document: `org.projectfile.pages.rules.items[]`, one entry per rule.
export function catalogYaml(rules: RuleExplanation[], t: Translator): string {
    const items = rules.map((rule) => ({
        id: rule.id,
        severity: rule.preset,
        score: rule.score,
        scope: rule.scope,
        rulesets: rule.rulesets,
        ...(rule.docs && { references: [rule.docs] }),
        ...(rule.message && { message: t._(rule.message) }),
    }));
    log.debug({ lang: t.lang, items: items.length }, "rule catalog rendered");
    return stringify({ org: { projectfile: { pages: { rules: { items } } } } }, { lineWidth: 0 }).trimEnd();
}

// Markdown text with every `<` and `>` outside code spans escaped, so a `<host>` placeholder is no HTML tag.
function escaped(markdown: string): string {
    return markdown
        .split("`")
        .map((part, index) => (index % 2 === 1 ? part : part.replaceAll("<", "&lt;").replaceAll(">", "&gt;")))
        .join("`");
}

// One rule’s page: its facts as a table, then its message, fixes, schema and references.
export function rulePage(rule: RuleExplanation, t: Translator): string {
    const rows: [string, string | undefined][] = [
        [t._("Severity"), rule.preset],
        [t._("Score"), rule.score],
        [t._("Scope"), rule.scope],
        [t._("Kind"), rule.kind],
        [t._("Rulesets"), rule.rulesets.map((name) => `[${name}](${relative(rule.id, rulesetFile(name))})`).join(", ") || undefined],
        [t._("Reads"), rule.facts.map((fact) => `\`${fact}\``).join(", ") || undefined],
    ];
    const table = ["| | |", "|---|---|", ...rows.filter((row): row is [string, string] => row[1] !== undefined).map(([label, value]) => `| ${label} | ${value} |`)];
    const schema = (label: string, value?: Record<string, unknown>) => (value ? [`## ${label}`, "```json\n" + JSON.stringify(value, undefined, 2) + "\n```"] : []);
    return [
        `# ${rule.id}`,
        table.join("\n"),
        ...(rule.message ? [`## ${t._("Message")}`, escaped(t._(rule.message))] : []),
        ...fixes(rule).flatMap((fix, index, all) => [`## ${all.length > 1 ? t._("Fix {number}", { number: index + 1 }) : t._("Fix")}`, escaped(t._(fix))]),
        ...schema(t._("Expects"), rule.expect),
        ...schema(t._("When"), rule.when),
        ...(rule.docs ? [`## ${t._("References")}`, `- <${rule.docs}>`] : []),
    ].join("\n\n");
}

// A ruleset’s page in the collection, `dns:core` as `rulesets/dns-core.md`.
function rulesetFile(name: string): string {
    return `rulesets/${name.replaceAll(":", "-")}.md`;
}

// The path from the page of rule `from` to the collection-relative `to`.
function relative(from: string, to: string): string {
    return path.posix.relative(path.posix.dirname(from), to);
}

// A ruleset’s page: its description, then a link to each rule it resolves to.
function rulesetPage(name: string, description: string, ids: string[], t: Translator): string {
    return [`# ${name}`, ...(description ? [escaped(t._(description))] : []), t._("Rules: {count}", { count: ids.length }), ids.map((id) => `- [${id}](${relative(rulesetFile(name), `${id}.md`)})`).join("\n")].join("\n\n");
}

// Every page under `directory`: a page per rule, one per shipped ruleset and an `index.md`; returns the page count.
export function writeRulePages(directory: string, rules: RuleExplanation[], t: Translator): number {
    const write = (file: string, body: string) => {
        const target = path.join(directory, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${body}\n`);
    };
    for (const rule of rules) write(`${rule.id}.md`, rulePage(rule, t));
    const presets = listPresets(layered([]));
    for (const preset of presets) {
        const ids = listRules(layered([]), [`spiderlint:${preset.name}`]).map((rule) => rule.id);
        write(rulesetFile(preset.name), rulesetPage(preset.name, preset.description, ids, t));
    }
    const index = [`# ${t._("Rules")}`, t._("Rules: {count}", { count: rules.length }), `## ${t._("Rulesets")}`, presets.map((preset) => `- [${preset.name}](${rulesetFile(preset.name)}): ${escaped(t._(preset.description))}`).join("\n")];
    write("index.md", index.join("\n\n"));
    log.info({ directory, lang: t.lang, rules: rules.length, rulesets: presets.length }, "rule pages written");
    return rules.length + presets.length + 1;
}
