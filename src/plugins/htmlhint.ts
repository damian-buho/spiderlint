// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

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

// A spiderlint preset from rule levels.
function preset(description: string, levels: Record<string, Level>): RulesetConfig {
    return { description, rules: Object.fromEntries(Object.entries(levels).map(([id, severity]) => [`${PREFIX}${id}`, severity])) };
}

const rules = Object.fromEntries(Object.keys(RULESET).map((id) => [`${PREFIX}${id}`, messageRule(ID, PREFIX, id, `https://htmlhint.com/rules/${id}`)]));

export default definePlugin({
    name: "htmlhint",
    extractors: [{ id: ID, extract }],
    rules,
    presets: {
        htmlhint: preset("Markup defects htmlhint reports by default: unpaired tags, duplicate IDs and attributes, a missing doctype or title", DEFAULT),
        "htmlhint:extra": preset("Defects htmlhint ships off: missing alt, labels, lang, meta tags, obsolete tags, unsafe attribute characters", EXTRA),
    },
});
