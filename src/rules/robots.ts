// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, RobotsFileFacts, RobotsGroupFacts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "./types.ts";

// AI crawler product tokens by purpose; `retired` ones no vendor still sends.
export const AI_CRAWLERS: Record<string, "training" | "search" | "user" | "retired"> = {
    gptbot: "training",
    claudebot: "training",
    ccbot: "training",
    "google-extended": "training",
    "applebot-extended": "training",
    bytespider: "training",
    "meta-externalagent": "training",
    "cohere-training-data-crawler": "training",
    ai2bot: "training",
    "oai-searchbot": "search",
    "claude-searchbot": "search",
    perplexitybot: "search",
    "chatgpt-user": "user",
    "claude-user": "user",
    "perplexity-user": "user",
    "anthropic-ai": "retired",
    "claude-web": "retired",
    "cohere-ai": "retired",
};

// Content Signals keys and the values each takes.
const SIGNALS = new Set(["search", "ai-input", "ai-train"]);
const VERDICTS = new Set(["yes", "no"]);

// A group shutting its agents out of every path.
function isBlanket(group: RobotsGroupFacts): boolean {
    return group.disallow.includes("/") && group.allow.length === 0;
}

// One site rule per robots.txt file: `judge` returns the finding’s message and value, or nothing.
function robotsRule(id: string, documentation: string, judge: (file: RobotsFileFacts) => { message: string; value: unknown } | undefined, fix?: string): Make {
    return (severity) => ({
        meta: { id, severity, scope: "site", facts: ["site.robots"], docs: documentation, ...(fix && { fix }) },
        check(_pages: Facts[], _group?: string, site?: SiteFacts) {
            const findings: Finding[] = [];
            const files = site?.robots ?? [];
            for (const file of files) {
                const verdict = judge(file);
                log.debug({ rule: id, url: file.url, isFinding: verdict !== undefined }, "robots.txt judged");
                if (verdict) findings.push({ rule: id, severity, scope: "site", url: file.url, ...verdict });
            }
            return findings;
        },
    });
}

// Every group naming `*` that disallows `/` and allows nothing back.
const disallowAll = robotsRule("robots/disallow-all", "https://www.rfc-editor.org/rfc/rfc9309#section-2.2.2", (file) => {
    const blanket = file.groups.filter((group) => group.agents.includes("*") && isBlanket(group));
    return blanket.length > 0 ? { message: "User-agent: * is disallowed from every path, so no crawler indexes the site", value: "/" } : undefined;
}, "Remove the Disallow: / rule from the User-agent: * group, or add Allow rules for the paths you want crawled.");

// The AI crawlers the file names, each with its purpose and whether it is shut out.
const aiCrawlers = robotsRule("robots/ai-crawlers", "https://www.rfc-editor.org/rfc/rfc9309#section-2.2.1", (file) => {
    const named = file.groups.flatMap((group) => group.agents.flatMap((agent) => (Object.hasOwn(AI_CRAWLERS, agent) ? [{ agent, purpose: AI_CRAWLERS[agent], blocked: isBlanket(group) }] : [])));
    if (named.length === 0) return;
    const listed = named.map(({ agent, purpose, blocked }) => `${agent} (${purpose}${blocked ? ", disallowed" : ""})`).join(", ");
    return { message: `names AI crawlers: ${listed}`, value: named };
}, "Confirm each named AI crawler is allowed or disallowed as intended.");

// Every `Content-Signal` line naming an unknown signal, a value other than yes or no, or nothing.
const contentSignal = robotsRule("robots/content-signal", "https://contentsignals.org/", (file) => {
    const malformed = file["content-signals"].filter(({ signals }) => {
        const entries = Object.entries(signals);
        return entries.length === 0 || entries.some(([key, value]) => !SIGNALS.has(key) || !VERDICTS.has(value));
    });
    return malformed.length > 0 ? { message: `Content-Signal should be search, ai-input or ai-train set to yes or no, found ${malformed.map((line) => `“${line.value}”`).join(", ")}`, value: malformed.map((line) => line.value) } : undefined;
}, "Write each Content-Signal line as comma-separated signal=yes|no pairs, e.g. Content-Signal: search=yes, ai-input=no, ai-train=no.");

export const robotsRules: Record<string, Make> = {
    "robots/disallow-all": disallowAll,
    "robots/ai-crawlers": aiCrawlers,
    "robots/content-signal": contentSignal,
};
