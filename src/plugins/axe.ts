// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { AxeBuilder } from "@axe-core/playwright";
import axeCore from "axe-core";
import type { Page } from "playwright";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make, RulesetConfig, Severity } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "axe";
const PREFIX = "axe/";
const WCAG = new Set(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);

export interface AxeFacts {
    violations: { rule: string; impact?: string; help: string; targets: string[] }[];
}

// The rules axe runs by default: no experimental, AAA or obsolete ones.
const RULES = axeCore.getRules().filter((rule) => (rule as { enabled?: boolean }).enabled !== false);
const isWcag = (tags: string[]) => tags.some((tag) => WCAG.has(tag));

// One finding per violated rule on a page, its impact and element selectors as the value.
function rule(id: string, helpUrl: string): Make {
    const ruleId = `${PREFIX}${id}`;
    return (severity) => ({
        meta: { id: ruleId, severity, scope: "page", facts: [`${ID}.violations`], docs: helpUrl },
        check(page: Facts) {
            const facts = page[ID] as AxeFacts | undefined;
            if (!facts) return;
            const hits = facts.violations.filter((violation) => violation.rule === id);
            log.debug({ rule: ruleId, url: page.url.href, violations: hits.length }, "axe violations judged");
            return hits.map(({ impact, help, targets }): Finding => ({ rule: ruleId, severity, scope: "page", url: page.url.href, group: page.group, message: help, value: { ...(impact && { impact }), targets } }));
        },
    });
}

// A spiderlint preset from the axe rules `isChosen` keeps: WCAG A and AA as errors, the rest as warnings.
function preset(description: string, isChosen: (tags: string[]) => boolean): RulesetConfig {
    const chosen = RULES.filter((entry) => isChosen(entry.tags));
    return { description, rules: Object.fromEntries(chosen.map((entry): [string, Severity] => [`${PREFIX}${entry.ruleId}`, isWcag(entry.tags) ? "error" : "warning"])) };
}

// Runs axe inside the crawler’s rendered page; a non-HTML page gives nothing.
async function extract(page: Facts, _body: string, live?: Page): Promise<AxeFacts | undefined> {
    if (!live || !page.html) return;
    const results = await new AxeBuilder({ page: live }).analyze();
    const violations = results.violations.map(({ id, impact, help, nodes }) => ({ rule: id, ...(impact && { impact }), help, targets: nodes.map((node) => node.target.join(" >>> ")) }));
    log.debug({ url: page.url.href, violations: violations.length, passes: results.passes.length }, "axe analysed");
    return { violations };
}

export default definePlugin({
    name: "axe",
    extractors: [{ id: ID, mode: "browser", extract }],
    rules: Object.fromEntries(RULES.map((entry) => [`${PREFIX}${entry.ruleId}`, rule(entry.ruleId, entry.helpUrl.replace(/\?.*$/, ""))])),
    presets: {
        axe: preset("Accessibility checked by axe-core in the rendered page: WCAG A and AA, and best practices", () => true),
        "axe:wcag": preset("WCAG 2.2 A and AA success criteria axe-core can test", isWcag),
        "axe:best-practice": preset("axe-core best practices beyond WCAG", (tags) => tags.includes("best-practice")),
    },
});
