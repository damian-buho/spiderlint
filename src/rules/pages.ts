// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { layered } from "../config/index.ts";
import type { Translator } from "../i18n.ts";
import { log } from "../logger.ts";
import { FLOORS } from "../report/rating.ts";
import { listRules, listPresets, type RuleExplanation } from "./catalog.ts";
import { fixFor } from "./fix.ts";
import { BANDS } from "./score.ts";

export const PAGE_FORMATS = ["yaml", "markdown"];

// The ruleset a group runs when its config names none.
const DEFAULT_RULESET = "recommended";

// The collections rule and ruleset pages belong to, rendered side by side as `<dir>/rules/` and `<dir>/rulesets/`.
export const RULES = "rules";
export const RULESETS = "rulesets";

// Every shipped rule, read with no user config so the catalog is the same on every machine.
export function shippedCatalog(): RuleExplanation[] {
    return listRules(layered([]), []);
}

// A rule’s fixes in order, placeholders shown as `<host>`, a fix that only repeats the title left out.
function fixes(rule: RuleExplanation): string[] {
    return [rule.fix, ...(rule.extra ?? [])].filter((fix): fix is string => fix !== undefined && fix !== rule.title).map((fix) => fixFor(fix));
}

// Collection `name`'s catalog as a projectfile document: `org.projectfile.pages.<name>.items[]`.
function catalogDocument(name: string, items: object[]): string {
    return stringify({ org: { projectfile: { pages: { [name]: { items } } } } }, { lineWidth: 0 }).trimEnd();
}

// The rule catalog, one entry per rule.
export function catalogYaml(rules: RuleExplanation[], t: Translator): string {
    const items = rules.map((rule) => ({
        id: rule.id,
        ...(rule.title && { title: t._(rule.title) }),
        severity: rule.preset,
        score: rule.score,
        scope: rule.scope,
        rulesets: rule.rulesets,
        ...(rule.docs && { references: [rule.docs] }),
        ...(rule.rationale && { rationale: t._(rule.rationale) }),
        ...(rule.message && { message: t._(rule.message) }),
    }));
    log.debug({ lang: t.lang, items: items.length }, "rule catalog rendered");
    return catalogDocument(RULES, items);
}

// The ruleset catalog, one entry per shipped ruleset with the rules it resolves to.
export function rulesetCatalogYaml(t: Translator): string {
    const items = listPresets(layered([])).map((preset) => ({ id: preset.name, ...(preset.description && { description: t._(preset.description) }), rules: presetRules(preset.name).map((rule) => rule.id) }));
    log.debug({ lang: t.lang, items: items.length }, "ruleset catalog rendered");
    return catalogDocument(RULESETS, items);
}

// The rules shipped ruleset `name` resolves to.
function presetRules(name: string): RuleExplanation[] {
    return listRules(layered([]), [`spiderlint:${name}`]);
}

// Markdown text with every `<` and `>` outside code spans escaped, so a `<host>` placeholder is no HTML tag.
function escaped(markdown: string): string {
    return markdown
        .split("`")
        .map((part, index) => (index % 2 === 1 ? part : part.replaceAll("<", "&lt;").replaceAll(">", "&gt;")))
        .join("`");
}

// A report message as a page reads it: `{got}` as the localized “the value found”, any other placeholder as `<name>`.
function messageText(message: string, t: Translator): string {
    const value = t._("the value found");
    return escaped(message.replaceAll(/\{(\w+)\}/g, (_match, name: string) => (name === "got" ? `_${value}_` : `<${name}>`)));
}

// The family a rule’s page belongs to, `dns` for `dns/caa/missing`.
function family(id: string): string {
    return id.split("/", 1)[0] as string;
}

// The section a rule sits under on its family page, `dns/caa` for `dns/caa/missing`; none for a two-part ID.
function section(id: string): string | undefined {
    const parts = id.split("/");
    return parts.length > 2 ? parts.slice(0, -1).join("/") : undefined;
}

// A family’s page, `dns` as `rules/dns.md`.
function familyFile(name: string): string {
    return `${RULES}/${name}.md`;
}

// A ruleset’s page, `dns:core` as `rulesets/dns-core.md`.
function rulesetFile(name: string): string {
    return `${RULESETS}/${name.replaceAll(":", "-")}.md`;
}

// Collection `name`’s own index page.
function indexFile(name: string): string {
    return `${name}/index.md`;
}

// The path from page `from` to the collection-relative `to`.
function relative(from: string, to: string): string {
    return path.posix.relative(path.posix.dirname(from), to);
}

// The link from page `from` to rule `id`’s section, anchored by the rule ID.
export function ruleLink(from: string, id: string): string {
    return `${relative(from, familyFile(family(id)))}#${id}`;
}

// A score as the page shows it: `5.4`, or `1.6–3.0` for one that grows with what was measured.
function scoreRange(score: string): string {
    const points = score
        .matchAll(/→ (\d+\.\d)/g)
        .map((match) => Number(match[1]))
        .toArray();
    return points.length > 0 ? `${Math.min(...points).toFixed(1)}–${Math.max(...points).toFixed(1)}` : score;
}

// The label of a reference: its host, `www.` dropped.
function referenceLabel(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return url;
    }
}

// Whether the rule runs with no config, and the rulesets that turn it on when not.
function availability(rule: RuleExplanation, from: string, defaults: Set<string>, t: Translator): string {
    const links = rule.rulesets.map((name) => `[${name}](${relative(from, rulesetFile(name))})`).join(", ");
    if (rule.preset === "off") return t._("Off in every shipped ruleset; an override turns it on.");
    if (defaults.has(rule.id)) return t._("Runs by default, in the {ruleset} ruleset.", { ruleset: `[${DEFAULT_RULESET}](${relative(from, rulesetFile(DEFAULT_RULESET))})` });
    if (links) return t._("Off by default; a group that runs {rulesets} turns it on.", { rulesets: links });
    return t._("Off by default; name it in a ruleset of your own to turn it on.");
}

// A labelled JSON Schema block, or nothing when the rule has none.
function schemaBlock(label: string, value?: Record<string, unknown>): string[] {
    return value ? [`**${label}**`, "```json\n" + JSON.stringify(value, undefined, 2) + "\n```"] : [];
}

// A severity’s score band, `3.3–6.5`.
function band(level: keyof typeof BANDS): string {
    return `${BANDS[level].min.toFixed(1)}–${BANDS[level].max.toFixed(1)}`;
}

// The rule-author details: what the rule reads and the schemas it holds facts to, folded away from readers.
function authorDetails(rule: RuleExplanation, t: Translator): string[] {
    const body = [...(rule.facts.length > 0 ? [`**${t._("Reads")}**`, rule.facts.map((fact) => `- \`${fact}\``).join("\n")] : []), ...schemaBlock(t._("Expects"), rule.expect), ...schemaBlock(t._("When"), rule.when)];
    return body.length > 0 ? [`<details>\n<summary>${t._("For rule authors")}</summary>`, ...body, "</details>"] : [];
}

// One rule’s section at heading `level`: title, facts line, rationale, report message, fixes, availability, references.
export function ruleSection(rule: RuleExplanation, from: string, level: number, defaults: Set<string>, t: Translator): string {
    const index = relative(from, indexFile(RULES));
    const facts = [`\`${rule.id}\``, `[${rule.preset}](${index}#severity)`, `${t._("score")} [${scoreRange(rule.score)}](${index}#score)`, `[${rule.scope}](${index}#scope)`];
    const all = fixes(rule);
    return [
        `${"#".repeat(level)} ${escaped(rule.title ? t._(rule.title) : rule.id)} {#${rule.id}}`,
        facts.join(" · "),
        ...(rule.rationale ? [escaped(t._(rule.rationale))] : []),
        ...(rule.message ? [`**${t._("Reported as")}**`, `> ${messageText(t._(rule.message), t)}`] : []),
        ...all.flatMap((fix, index) => [`**${all.length > 1 ? t._("Fix {number}", { number: index + 1 }) : t._("Fix")}**`, escaped(t._(fix))]),
        availability(rule, from, defaults, t),
        ...(rule.docs ? [`**${t._("References")}**`, `- [${referenceLabel(rule.docs)}](${rule.docs})`] : []),
        ...authorDetails(rule, t),
    ].join("\n\n");
}

// A family’s page: its two-part rules first, then one section per shared prefix, every rule anchored by its ID.
export function familyPage(name: string, rules: RuleExplanation[], defaults: Set<string>, t: Translator): string {
    const from = familyFile(name);
    const loose = rules.filter((rule) => section(rule.id) === undefined);
    const sections = Map.groupBy(
        rules.filter((rule) => section(rule.id) !== undefined),
        (rule) => section(rule.id) as string,
    );
    return [`# ${name}`, t._("Rules: {count}", { count: rules.length }), ...loose.map((rule) => ruleSection(rule, from, 2, defaults, t)), ...[...sections].flatMap(([prefix, members]) => [`## ${prefix}`, ...members.map((rule) => ruleSection(rule, from, 3, defaults, t))])].join("\n\n");
}

// A ruleset’s page: its description, then a link to each rule it resolves to.
function rulesetPage(name: string, description: string, rules: RuleExplanation[], t: Translator): string {
    const from = rulesetFile(name);
    const items = rules.map((rule) => `- [\`${rule.id}\`](${ruleLink(from, rule.id)})${rule.title ? ` ${escaped(t._(rule.title))}` : ""}`);
    return [`# ${name}`, ...(description ? [escaped(t._(description))] : []), t._("Rules: {count}", { count: rules.length }), items.join("\n")].join("\n\n");
}

// What a ruleset is and which one a group runs by default, linked from `from`.
function rulesetsText(from: string, t: Translator): string {
    return t._("A ruleset names the rules a URL group runs; the command line calls the shipped ones presets (`spiderlint list-presets`). A group with no rulesets of its own runs {ruleset}.", { ruleset: `[${DEFAULT_RULESET}](${relative(from, rulesetFile(DEFAULT_RULESET))})` });
}

// The rules index: what severity, score, scope and rulesets mean, how to turn a rule on or off, then every family.
function indexPage(rules: RuleExplanation[], families: string[], t: Translator): string {
    const from = indexFile(RULES);
    const grades = FLOORS.map(([tenths, grade]) => `${grade} ≥ ${tenths * 10} %`).join(", ");
    const example = ["```yaml", "org:", "  spiderlint:", "    groups:", "      default:", "        rules: [recommended, tls-probe]", "    exclude-rules: [dns/ns/single]", "    override:", "      error: [http/hsts/missing]", "```"].join("\n");
    return [
        `# ${t._("Rules")}`,
        t._("Rules: {count}", { count: rules.length }),
        `## ${t._("Severity")} {#severity}`,
        t._("Each finding has a severity: error, warning, info or hint. `--fail-on` sets the lowest severity, or score, that fails the run."),
        `## ${t._("Score")} {#score}`,
        t._("Each finding scores 0.0 to 9.9, and the score sets its severity: error {error}, warning {warning}, info {info}, hint {hint}. Some rules score by what they measured, so their page shows a range.", { error: band("error"), warning: band("warning"), info: band("info"), hint: band("hint") }),
        t._("The report grades a run S to F by the share of checks that passed, a failed check costing more as its score rises: {grades}. S means no check failed; an error caps the grade at B.", { grades }),
        `## ${t._("Scope")} {#scope}`,
        t._("A page rule judges one page at a time. A group rule judges every page of a URL group together, such as every page of one template. A site rule judges the site once, such as its DNS or TLS."),
        `## [${t._("Rulesets")}](${relative(from, indexFile(RULESETS))}) {#rulesets}`,
        rulesetsText(from, t),
        `## ${t._("Turning rules on and off")} {#configure}`,
        t._("In the projectfile, `rules` adds rulesets to a group, `exclude-rules` drops rules, and `override` moves rules to another severity:"),
        example,
        `## ${t._("Families")}`,
        families.map((name) => `- [${name}](${relative(from, familyFile(name))})`).join("\n"),
    ].join("\n\n");
}

// The rulesets index: what a ruleset is, then every shipped ruleset.
function rulesetsIndexPage(presets: { name: string; description: string }[], t: Translator): string {
    const from = indexFile(RULESETS);
    return [`# ${t._("Rulesets")}`, rulesetsText(from, t), presets.map((preset) => `- [${preset.name}](${relative(from, rulesetFile(preset.name))}): ${escaped(t._(preset.description))}`).join("\n")].join("\n\n");
}

// A writer of collection-relative pages, `rules/dns.md`, into `directory`, which holds collection `name` alone.
function pageWriter(directory: string, name: string): (file: string, body: string) => void {
    return (file, body) => {
        const target = path.join(directory, path.posix.relative(name, file));
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${body}\n`);
    };
}

// Every rule page under `directory`: one per rule family and an `index.md`; returns the page count.
export function writeRulePages(directory: string, rules: RuleExplanation[], t: Translator): number {
    const write = pageWriter(directory, RULES);
    const defaults = new Set(presetRules(DEFAULT_RULESET).map((rule) => rule.id));
    const families = Map.groupBy(rules, (rule) => family(rule.id));
    for (const [name, members] of families) write(familyFile(name), familyPage(name, members, defaults, t));
    write(indexFile(RULES), indexPage(rules, families.keys().toArray(), t));
    log.info({ directory, lang: t.lang, rules: rules.length, families: families.size, defaults: defaults.size }, "rule pages written");
    return families.size + 1;
}

// Every ruleset page under `directory`: one per shipped ruleset and an `index.md`; returns the page count.
export function writeRulesetPages(directory: string, rules: RuleExplanation[], t: Translator): number {
    const write = pageWriter(directory, RULESETS);
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const presets = listPresets(layered([]));
    for (const preset of presets)
        write(
            rulesetFile(preset.name),
            rulesetPage(
                preset.name,
                preset.description,
                presetRules(preset.name).map((rule) => byId.get(rule.id) ?? rule),
                t,
            ),
        );
    write(indexFile(RULESETS), rulesetsIndexPage(presets, t));
    log.info({ directory, lang: t.lang, rulesets: presets.length }, "ruleset pages written");
    return presets.length + 1;
}

// The page collections the `rules` and `rulesets` commands print and render.
export const PAGE_COLLECTIONS: Record<string, { catalog: (t: Translator) => string; write: (directory: string, t: Translator) => number }> = {
    [RULES]: { catalog: (t) => catalogYaml(shippedCatalog(), t), write: (directory, t) => writeRulePages(directory, shippedCatalog(), t) },
    [RULESETS]: { catalog: (t) => rulesetCatalogYaml(t), write: (directory, t) => writeRulesetPages(directory, shippedCatalog(), t) },
};
