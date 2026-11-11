// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import type { Configuration } from "markdownlint";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RulesetConfig, Severity } from "../rules/types.ts";
import { messageRule, type MarkupMessage } from "./messages.ts";
import type { Extractor, Plugin } from "./types.ts";

const ID = "markdownlint";
const PREFIX = "markdownlint/";
const SOURCE = 120;

type Level = Exclude<Severity, "off">;

// Types a Markdown page is served as.
export const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

// A schema node with its `default` keywords dropped, since they sit where Ajv ignores them.
function bare(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((item) => bare(item));
    return node && typeof node === "object" ? Object.fromEntries(Object.entries(node).flatMap(([key, value]) => (key === "default" ? [] : [[key, key === "properties" ? bareEach(value as object) : bare(value)]]))) : node;
}

// Each named schema of a `properties` map, bared; a property may itself be called `default`.
function bareEach(properties: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(properties).map(([name, schema]) => [name, bare(schema)]));
}

// markdownlint’s own config schema, which its package exports leave out.
const SCHEMA_URL = new URL("../schema/markdownlint-config-schema.json", import.meta.resolve("markdownlint"));
const { $schema: _draft, $id: _id, ...SCHEMA } = JSON.parse(readFileSync(SCHEMA_URL, "utf8")) as Record<string, unknown> & { properties: Record<string, { description?: string }> };

// Each markdownlint rule as `[name, alias, description, documentation]`, read off the schema’s `MD001/heading-increment : … : url` descriptions.
const UPSTREAM = Object.entries(SCHEMA.properties).flatMap(([name, { description = "" }]) => {
    const [names = "", text = "", documentation = ""] = description.split(" : ", 3);
    const alias = names.split("/", 2)[1];
    return alias && /^MD\d{3}$/.test(name) ? [[name, alias, text, documentation] as const] : [];
});

// Rules a renderer or an agent misreads, at the level each is judged.
const DEFECTS = new Map<string, Level>([
    ["MD011", "warning"],
    ["MD018", "warning"],
    ["MD019", "warning"],
    ["MD031", "warning"],
    ["MD039", "warning"],
    ["MD040", "info"],
    ["MD042", "warning"],
    ["MD045", "warning"],
    ["MD051", "warning"],
    ["MD052", "warning"],
    ["MD053", "warning"],
    ["MD056", "warning"],
]);

// What llms.txt and llms-full.txt are linted with: the defects alone, so `llms-txt-valid`’s H1 and link checks stay the only ones.
export const LLMS_CONFIG: Configuration = { default: false, ...Object.fromEntries(DEFECTS.keys().map((name) => [name, true])) };

export interface MarkdownMessage extends MarkupMessage {
    aliases: string[];
}

export interface MarkdownlintSettings {
    config?: Configuration;
}

const loaded: { library?: Promise<typeof import("markdownlint/sync")> } = {};

// markdownlint’s findings on `text` under `config`, each named by its alias; the library loads on the first call.
export async function lintMarkdown(text: string, config: Configuration): Promise<MarkdownMessage[]> {
    loaded.library ??= import("markdownlint/sync");
    const { lint } = await loaded.library;
    const errors = lint({ strings: { text }, config, handleRuleFailures: true }).text ?? [];
    return errors.map(({ ruleNames, ruleDescription, lineNumber, errorRange, errorDetail, errorContext }) => {
        const source = [errorDetail, errorContext].filter(Boolean).join(" ");
        return { rule: ruleNames[1] ?? ruleNames[0] ?? "", aliases: ruleNames, message: ruleDescription, line: lineNumber, column: errorRange?.[0] ?? 1, ...(source && { source: source.length > SOURCE ? `${source.slice(0, SOURCE)}…` : source }) };
    });
}

// Lints a Markdown page under the configured rules over every rule markdownlint ships; a truncated body is skipped.
const extractor: Extractor = {
    id: ID,
    async extract(page: Facts, body: string, _live, _context, settings) {
        const isMarkdown = MARKDOWN_TYPES.has(page.http["content-type"] ?? "");
        if (!isMarkdown || page.http.size.truncated) {
            log.debug({ url: page.url.href, type: page.http["content-type"], truncated: page.http.size.truncated === true }, "markdownlint skipped");
            return;
        }
        const config = { default: true, ...(settings as MarkdownlintSettings | undefined)?.config };
        const messages = await lintMarkdown(body, config);
        log.debug({ url: page.url.href, configured: Object.keys(config).length, messages: messages.length }, "markdown linted");
        return { messages };
    },
};

// A spiderlint preset from rule levels, keyed by alias.
function preset(description: string, levels: Map<string, Level>): RulesetConfig {
    return {
        description,
        rules: Object.fromEntries(
            UPSTREAM.flatMap(([name, alias]) => {
                const level = levels.get(name);
                return level ? [[`${PREFIX}${alias}`, level]] : [];
            }),
        ),
    };
}

const rules = Object.fromEntries(UPSTREAM.map(([name, alias, , documentation]) => [`${PREFIX}${alias}`, messageRule(ID, PREFIX, alias, documentation, `Change the Markdown at each location, or accept the style with \`${name}: false\` under \`org.spiderlint.markdownlint.config\`.`)]));

export default {
    name: "markdownlint",
    settings: { type: "object", additionalProperties: false, properties: { config: bare(SCHEMA) } },
    extractors: [extractor],
    rules,
    presets: {
        markdownlint: preset("Markdown a renderer or agent misreads: reversed or empty links, missing alt text, undefined references, broken tables and headings", DEFECTS),
        "markdownlint:extra": preset("Markdown house style: line length, list, heading, emphasis and table style, spacing", new Map(UPSTREAM.filter(([name]) => !DEFECTS.has(name)).map(([name]) => [name, "info"]))),
    },
} satisfies Plugin;
