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

export interface AxeElement {
    target: string;
    html: string;
    xpath?: string;
    ancestry?: string;
}

export interface AxeCheck {
    id: string;
    impact?: string;
    message: string;
    data?: unknown;
    related: AxeElement[];
}

export interface AxeNode extends AxeElement {
    impact?: string;
    summary?: string;
    any: AxeCheck[];
    all: AxeCheck[];
    none: AxeCheck[];
}

export interface AxeResult {
    rule: string;
    impact?: string;
    tags: string[];
    description: string;
    help: string;
    error?: string;
    nodes: AxeNode[];
}

export interface AxeFacts {
    version: string;
    violations: AxeResult[];
    incomplete: AxeResult[];
}

type Path = axeCore.UnlabelledFrameSelector;
const LOCATION_HTML = 120;

// The rules axe runs by default: no experimental, AAA or obsolete ones.
const RULES = axeCore.getRules().filter((rule) => (rule as { enabled?: boolean }).enabled !== false);
const isWcag = (tags: string[]) => tags.some((tag) => WCAG.has(tag));

// A frame and shadow path as one string, each boundary crossed marked `>>>`.
function joined(path: Path): string {
    return path.map((step) => [step].flat().join(" >>> ")).join(" >>> ");
}

// Selector, markup, XPath and ancestry of one element axe reported.
function element(node: { target: Path; html: string; xpath?: string[]; ancestry?: Path }): AxeElement {
    const { target, html, xpath, ancestry } = node;
    return { target: joined(target), html, ...(xpath && { xpath: xpath.join(" >>> ") }), ...(ancestry && { ancestry: joined(ancestry) }) };
}

// A check axe ran on an element, its related elements included.
function check({ id, impact, message, data, relatedNodes }: axeCore.CheckResult): AxeCheck {
    return { id, ...(impact && { impact }), message, ...(data !== null && data !== undefined && { data }), related: (relatedNodes ?? []).map((related) => element(related)) };
}

// Everything axe says about one rule’s result on a page, DOM handles dropped.
function result(entry: axeCore.Result & { error?: { message?: string } }): AxeResult {
    const { id, impact, tags, description, help, nodes, error } = entry;
    return {
        rule: id,
        ...(impact && { impact }),
        tags,
        description,
        help,
        ...(error?.message && { error: error.message }),
        nodes: nodes.map((node) => ({ ...element(node), ...(node.impact && { impact: node.impact }), ...(node.failureSummary && { summary: node.failureSummary }), any: node.any.map((entry) => check(entry)), all: node.all.map((entry) => check(entry)), none: node.none.map((entry) => check(entry)) })),
    };
}

// An element’s selector, opening tag and related elements, on one line.
function locate(node: AxeNode): string {
    const tag = /^<[^>]*>/.exec(node.html)?.[0] ?? node.html;
    const html = tag.length > LOCATION_HTML ? `${tag.slice(0, LOCATION_HTML)}…` : tag;
    const related = [...new Set([...node.any, ...node.all, ...node.none].flatMap((entry) => entry.related.map((relatedElement) => relatedElement.target)))];
    return `${node.target} ${html}${related.length > 0 ? `, related: ${related.join(", ")}` : ""}`;
}

// One finding per violated rule on a page, its impact and elements as the value.
function rule(id: string, helpUrl: string): Make {
    const ruleId = `${PREFIX}${id}`;
    return (severity) => ({
        meta: { id: ruleId, severity, scope: "page", facts: [`${ID}.violations`], docs: helpUrl },
        check(page: Facts) {
            const facts = page[ID] as AxeFacts | undefined;
            if (!facts) return;
            const hits = facts.violations.filter((violation) => violation.rule === id);
            log.debug({ rule: ruleId, url: page.url.href, violations: hits.length }, "axe violations judged");
            return hits.map(({ impact, help, nodes }): Finding => ({
                rule: ruleId,
                severity,
                scope: "page",
                url: page.url.href,
                group: page.group,
                message: help,
                value: { ...(impact && { impact }), nodes: nodes.map(({ target, html, summary }) => ({ target, html, ...(summary && { summary }) })) },
                locations: nodes.map((node) => locate(node)),
            }));
        },
    });
}

// A spiderlint preset from the axe rules `isChosen` keeps: WCAG A and AA as errors, the rest as warnings.
function preset(description: string, isChosen: (tags: string[]) => boolean): RulesetConfig {
    const chosen = RULES.filter((entry) => isChosen(entry.tags));
    return { description, rules: Object.fromEntries(chosen.map((entry): [string, Severity] => [`${PREFIX}${entry.ruleId}`, isWcag(entry.tags) ? "error" : "warning"])) };
}

// Runs axe inside the crawler’s rendered page, keeping violations and what it could not decide; a non-HTML page gives nothing.
async function extract(page: Facts, _body: string, live?: Page): Promise<AxeFacts | undefined> {
    if (!live || !page.html) return;
    const results = await new AxeBuilder({ page: live }).options({ xpath: true, ancestry: true }).analyze();
    const facts = { version: results.testEngine.version, violations: results.violations.map((entry) => result(entry)), incomplete: results.incomplete.map((entry) => result(entry)) };
    log.debug({ url: page.url.href, violations: facts.violations.length, incomplete: facts.incomplete.length, passes: results.passes.length }, "axe analysed");
    return facts;
}

export default definePlugin({
    name: "axe",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", cached: false, extract }],
    rules: Object.fromEntries(RULES.map((entry) => [`${PREFIX}${entry.ruleId}`, rule(entry.ruleId, entry.helpUrl.replace(/\?.*$/, ""))])),
    presets: {
        axe: preset("Accessibility checked by axe-core in the rendered page: WCAG A and AA, and best practices", () => true),
        "axe:wcag": preset("WCAG 2.2 A and AA success criteria axe-core can test", isWcag),
        "axe:best-practice": preset("axe-core best practices beyond WCAG", (tags) => tags.includes("best-practice")),
    },
});
