// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { HTMLHint } from "htmlhint/dist/core/core.js";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RulesetConfig, Severity } from "../rules/types.ts";
import { messageRule, type MarkupMessage } from "./messages.ts";
import { definePlugin } from "./types.ts";

const ID = "htmlhint";
const PREFIX = "htmlhint/";
const SOURCE = 120;

type Level = Exclude<Severity, "off">;

// htmlhint’s default ruleset, every rule of which reports an error.
const DEFAULT: Record<string, Level> = Object.fromEntries(Object.keys(HTMLHint.defaultRuleset).map((id) => [id, "error"]));
// Rules htmlhint ships off that judge a defect rather than a house style, at the level each reports.
const EXTRA: Record<string, Level> = {
    "alt-require": "warning",
    "attr-no-unnecessary-whitespace": "error",
    "attr-unsafe-chars": "warning",
    "attr-value-no-duplication": "error",
    "attr-whitespace": "error",
    "button-type-require": "warning",
    "doctype-html5": "warning",
    "frame-title-require": "warning",
    "h1-require": "warning",
    "html-lang-require": "warning",
    "id-class-ad-disabled": "warning",
    "input-requires-label": "warning",
    "main-require": "warning",
    "meta-charset-require": "error",
    "meta-description-require": "error",
    "meta-viewport-require": "error",
    "tag-no-obsolete": "error",
    "tagname-specialchars": "error",
};
const RULESET = Object.fromEntries(Object.keys({ ...DEFAULT, ...EXTRA }).map((id) => [id, true]));

// How much each rule matters, inside its own level’s band; absent keeps the band’s base.
const SCORES: Record<string, number> = {
    "tag-pair": 9,
    "id-unique": 8.4,
    "src-not-empty": 8.2,
    "attr-no-duplication": 7.8,
    "title-require": 7.6,
    "spec-char-escape": 7.4,
    "doctype-first": 7,
    "tagname-lowercase": 6.8,
    "attr-lowercase": 6.8,
    "attr-value-double-quotes": 6.6,
    "meta-charset-require": 7.8,
    "meta-viewport-require": 7.6,
    "meta-description-require": 7.2,
    "tag-no-obsolete": 7,
    "tagname-specialchars": 6.8,
    "attr-value-no-duplication": 6.8,
    "attr-whitespace": 6.6,
    "attr-no-unnecessary-whitespace": 6.6,
    "alt-require": 6.2,
    "input-requires-label": 6,
    "h1-require": 5.8,
    "html-lang-require": 5.6,
    "main-require": 5.4,
    "frame-title-require": 4.6,
    "button-type-require": 4.8,
    "attr-unsafe-chars": 4.4,
    "doctype-html5": 4.2,
    "id-class-ad-disabled": 3.6,
};

// htmlhint’s rule descriptions, keyed by ID; `fix` is derived from them where present.
const DESCRIPTIONS = new Map<string, string>();
for (const [id, rule] of Object.entries(HTMLHint.rules)) if (rule?.description) DESCRIPTIONS.set(id, rule.description);

export interface HtmlHintFacts {
    messages: (MarkupMessage & { type: string })[];
}

// Lints an HTML page’s body; a truncated body would fail on tags the cap cut off, so it is skipped.
async function extract(page: Facts, body: string): Promise<HtmlHintFacts | undefined> {
    if (!page.html || page.http.size.truncated) {
        log.debug({ url: page.url.href, isHtml: page.html !== undefined, truncated: page.http.size.truncated === true }, "htmlhint skipped");
        return;
    }
    const hints = HTMLHint.verify(body, RULESET);
    const messages = hints.map(({ rule, type, message, line, col, raw }) => ({ rule: rule.id, type, message, line, column: col, ...(raw && { source: raw.length > SOURCE ? `${raw.slice(0, SOURCE)}…` : raw }) }));
    log.debug({ url: page.url.href, rules: Object.keys(RULESET).length, messages: messages.length }, "html hinted");
    return { messages };
}

// A spiderlint preset from rule levels, each rule scored by how much it matters.
function preset(description: string, levels: Record<string, Level>): RulesetConfig {
    return { description, rules: Object.fromEntries(Object.entries(levels).map(([id, severity]): [string, Level | { severity: Level; score: number }] => [`${PREFIX}${id}`, SCORES[id] === undefined ? severity : { severity, score: SCORES[id] as number }])) };
}

const rules = Object.fromEntries(Object.keys(RULESET).map((id) => [`${PREFIX}${id}`, messageRule(ID, PREFIX, id, `https://htmlhint.com/rules/${id}`, DESCRIPTIONS.get(id))]));

export default definePlugin({
    name: "htmlhint",
    extractors: [{ id: ID, extract }],
    rules,
    presets: {
        htmlhint: preset("Markup defects htmlhint reports by default: unpaired tags, duplicate IDs and attributes, a missing doctype or title", DEFAULT),
        "htmlhint:extra": preset("Defects htmlhint ships off: missing alt, labels, lang, meta tags, obsolete tags, unsafe attribute characters", EXTRA),
    },
});
