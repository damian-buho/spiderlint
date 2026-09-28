// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { HtmlValidate, StaticConfigLoader, type RuleConfig } from "html-validate";
import { a11y, document as wholeDocument, recommended, standard } from "html-validate/presets";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Make, RulesetConfig, Severity } from "../rules/types.ts";
import { messageRule } from "./messages.ts";
import { definePlugin } from "./types.ts";

const UPSTREAM = { recommended, document: wholeDocument, standard, a11y };
type Upstream = keyof typeof UPSTREAM;

const ID = "htmlvalidate";
const PREFIX = "html-validate/";
const BASE: Upstream[] = ["recommended", "document"];
// Judges html-validate’s own configuration, never a page.
const IGNORED = new Set(["deprecated-rule"]);

export interface HtmlValidateFacts {
    messages: { rule: string; message: string; severity: number; line: number; column: number; offset: number; size: number; selector?: string; source?: string; context?: unknown }[];
}

const SOURCE = 120;

// The tag in `body` around `offset`, cut at SOURCE characters.
function sourceAt(body: string, offset: number): string | undefined {
    const start = body.lastIndexOf("<", offset);
    const end = body.indexOf(">", offset);
    if (start === -1 || end === -1 || offset - start > SOURCE) return undefined;
    const tag = body.slice(start, end + 1);
    return tag.length > SOURCE ? `${tag.slice(0, SOURCE)}…` : tag;
}

// Same-origin scripts need no SRI, as `resources/sri` already judges.
const RULES: RuleConfig = { "require-sri": ["error", { target: "crossorigin" }] };
const presetNames = (names: string[]) => names.map((name) => `html-validate:${name}`);
// A rendered DOM is Chromium’s serialisation, so the serialisation-style rules are off for it.
const validators = {
    http: new HtmlValidate(new StaticConfigLoader({ extends: presetNames(BASE), rules: RULES })),
    browser: new HtmlValidate(new StaticConfigLoader({ extends: presetNames([...BASE, "browser"]), rules: RULES })),
};

// html-validate’s severity as spiderlint’s: 2 or error, 1 or warn, else off.
function severityOf(entry: unknown): Severity {
    const level = Array.isArray(entry) ? (entry[0] as unknown) : entry;
    if (level === "error" || level === 2) return "error";
    return level === "warn" || level === 1 ? "warning" : "off";
}

// The enabled rules of html-validate presets, later presets winning, as spiderlint severities.
function severities(presets: Upstream[]): Record<string, Exclude<Severity, "off">> {
    const entries = presets.flatMap((name) => Object.entries(UPSTREAM[name].rules ?? {}));
    const merged = Object.fromEntries(entries.map(([id, entry]) => [id, severityOf(entry)]));
    return Object.fromEntries(Object.entries(merged).filter(([id, severity]) => severity !== "off" && !IGNORED.has(id))) as Record<string, Exclude<Severity, "off">>;
}

// The first line of each html-validate rule description; a rule with none without an element context is exempt.
export const exempt: Set<string> = new Set();
const DESCRIPTIONS = new Map<string, string>();
const htmlValidateIds = Object.keys(severities(BASE));
for (const id of htmlValidateIds) {
    try {
        const documentation = validators.http.getContextualDocumentationSync({ ruleId: id, context: undefined });
        const summary = documentation?.description?.split("\n").map((line) => line.trim()).find(Boolean);
        if (summary) DESCRIPTIONS.set(id, summary);
        else {
            log.debug({ id }, "html-validate rule has no description");
            exempt.add(`${PREFIX}${id}`);
        }
    } catch {
        log.debug({ id }, "html-validate rule has no context-free description");
        exempt.add(`${PREFIX}${id}`);
    }
}

// The page rule of html-validate rule `id`; `fix` is derived from the upstream description when present.
function rule(id: string): Make {
    return messageRule(ID, PREFIX, id, `https://html-validate.org/rules/${id}.html`, DESCRIPTIONS.get(id));
}

// A spiderlint preset from html-validate presets.
function preset(description: string, presets: Upstream[]): RulesetConfig {
    return { description, rules: Object.fromEntries(Object.entries(severities(presets)).map(([id, severity]) => [`${PREFIX}${id}`, severity])) };
}

// Validates an HTML page’s body; a truncated body would fail on elements the cap cut off, so it is skipped.
async function extract(page: Facts, body: string): Promise<HtmlValidateFacts | undefined> {
    if (!page.html || page.http.size.truncated) {
        log.debug({ url: page.url.href, isHtml: page.html !== undefined, truncated: page.http.size.truncated === true }, "html-validate skipped");
        return;
    }
    const mode = page.browser ? "browser" : "http";
    const report = await validators[mode].validateString(body, page.url.href);
    const messages = report.results.flatMap((result) => result.messages).map(({ ruleId, message, severity, line, column, offset, size, selector, context }) => {
        const source = sourceAt(body, offset);
        return { rule: ruleId, message, severity, line, column, offset, size, ...(selector && { selector }), ...(source && { source }), ...(context !== undefined && { context: context as unknown }) };
    });
    log.debug({ url: page.url.href, mode, messages: messages.length }, "html validated");
    return { messages };
}

const rules = Object.fromEntries(Object.keys(severities(BASE)).map((id) => [`${PREFIX}${id}`, rule(id)]));

export default definePlugin({
    name: "html-validate",
    extractors: [{ id: ID, extract }],
    rules,
    presets: {
        "html-validate": preset("Markup validity, accessibility and document structure, checked by html-validate", BASE),
        "html-validate:standard": preset("Markup that breaks the HTML standard, with no style rules", ["standard"]),
        "html-validate:a11y": preset("Accessibility defects html-validate can see in the markup", ["a11y"]),
        "html-validate:document": preset("Defects only a whole document has: doctype, labels, heading levels, SRI", ["document"]),
    },
});
