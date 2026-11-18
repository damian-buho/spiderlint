// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { groupsFor } from "../crawl/robots.ts";
import type { ContentSignal, Facts, RobotsFileFacts, RobotsGroupFacts, SiteFacts, Stance } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "./message.ts";
import type { Finding, Make, RuleMeta } from "./types.ts";

// Crawler product tokens by purpose; `index` is a search engine, `retired` ones no vendor still sends.
export const CRAWLERS: Record<string, "index" | "training" | "search" | "user" | "retired"> = {
    googlebot: "index",
    bingbot: "index",
    applebot: "index",
    duckduckbot: "index",
    yandexbot: "index",
    baiduspider: "index",
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

// The Content Signal each purpose answers to.
export const SIGNAL_OF: Partial<Record<(typeof CRAWLERS)[string], ContentSignal>> = { index: "search", search: "ai-input", user: "ai-input", training: "ai-train" };

// Content Signals keys and the values each takes.
const SIGNALS = new Set(["search", "ai-input", "ai-train"]);
const VERDICTS = new Set(["yes", "no"]);

// A group shutting its agents out of every path.
function isBlanket(group: RobotsGroupFacts): boolean {
    return group.disallow.includes("/") && group.allow.length === 0;
}

// One site rule per robots.txt file: `judge` returns the finding’s sentence and value, or nothing.
function robotsRule(id: string, documentation: string, judge: (file: RobotsFileFacts, site?: SiteFacts) => Pick<Finding, "message" | "text" | "variables" | "data" | "locations" | "value"> | undefined, guide: Pick<RuleMeta, "title" | "rationale" | "fix">, facts: string[] = []): Make {
    return (severity) => ({
        meta: { id, severity, scope: "site", facts: ["site.robots", ...facts], docs: documentation, ...guide },
        check(_pages: Facts[], _group?: string, site?: SiteFacts) {
            const findings: Finding[] = [];
            const files = site?.robots ?? [];
            for (const file of files) {
                const verdict = judge(file, site);
                log.debug({ rule: id, url: file.url, isFinding: verdict !== undefined }, "robots.txt judged");
                if (verdict) findings.push({ rule: id, severity, scope: "site", url: file.url, ...verdict });
            }
            return findings;
        },
    });
}

// Every group naming `*` that disallows `/` and allows nothing back.
const disallowAll = robotsRule(
    "robots/root/blocked",
    "https://www.rfc-editor.org/rfc/rfc9309#section-2.2.2",
    (file) => {
        const blanket = file.groups.filter((group) => group.agents.includes("*") && isBlanket(group));
        return blanket.length > 0 ? { ...said("User-agent: * is disallowed from every path, so no crawler indexes the site"), value: "/" } : undefined;
    },
    {
        title: "robots.txt blocks every crawler from the whole site",
        rationale: "User-agent: * with Disallow: / and no Allow tells every well-behaved crawler to stay out, so search engines drop the site from their results.",
        fix: "Remove the Disallow: / rule from the User-agent: * group, or add Allow rules for the paths you want crawled.",
    },
);

// The AI crawlers the file names, each with its purpose and whether it is shut out.
const aiCrawlers = robotsRule(
    "robots/ai-crawlers/present",
    "https://www.rfc-editor.org/rfc/rfc9309#section-2.2.1",
    (file) => {
        const named = file.groups.flatMap((group) => group.agents.flatMap((agent) => (Object.hasOwn(CRAWLERS, agent) && CRAWLERS[agent] !== "index" ? { agent, purpose: CRAWLERS[agent], blocked: isBlanket(group) } : [])));
        if (named.length === 0) return;
        return { ...said("the file names AI crawlers"), locations: named.map(({ agent, purpose, blocked }) => `${agent} (${purpose}${blocked ? ", disallowed" : ""})`), value: named };
    },
    {
        title: "robots.txt addresses AI crawlers",
        rationale: "Rules for crawlers that train models or fetch pages for AI answers decide whether the content is used there. The finding lists each named crawler and whether it is shut out, so the owner can confirm that is intended.",
        fix: "Confirm each named AI crawler is allowed or disallowed as intended.",
    },
);

// Every `Content-Signal` line naming an unknown signal, a value other than yes or no, or nothing.
const contentSignal = robotsRule(
    "robots/content-signal/invalid",
    "https://contentsignals.org/",
    (file) => {
        const malformed = file["content-signals"].filter(({ signals }) => {
            const entries = Object.entries(signals);
            return entries.length === 0 || entries.some(([key, value]) => !SIGNALS.has(key) || !VERDICTS.has(value));
        });
        return malformed.length > 0 ? { ...said("Content-Signal should be search, ai-input or ai-train set to yes or no"), data: { [file.url]: { found: malformed.map((line) => line.value).join(", ") } }, value: malformed.map((line) => line.value) } : undefined;
    },
    {
        title: "A Content-Signal line in robots.txt is malformed",
        rationale: "Crawlers that read Content-Signal may ignore a line with an unknown signal or a value other than yes or no, so the owner’s wishes on search, AI input and AI training are not honoured.",
        fix: "Write each Content-Signal line as comma-separated signal=yes|no pairs, e.g. Content-Signal: search=yes, ai-input=no, ai-train=no.",
    },
);

// The stance a file serves: its `Content-Signal` lines outside a group or for `*`, the last one winning per signal.
export function servedStance(file: RobotsFileFacts): Stance {
    const lines = file["content-signals"].filter(({ agents }) => agents.length === 0 || agents.includes("*"));
    return Object.fromEntries(lines.flatMap(({ signals }) => Object.entries(signals).filter(([key, value]) => SIGNALS.has(key) && VERDICTS.has(value))));
}

// Whether `agent` is shut out of `/`: the groups RFC 9309 picks for it disallow `/` and allow nothing back.
export function isShutOut(file: RobotsFileFacts, agent: string): boolean {
    const groups = groupsFor(file, agent);
    return groups.some((group) => group.disallow.includes("/")) && groups.every((group) => group.allow.length === 0);
}

// Every crawler whose access contradicts the stance: shut out where its signal says yes, let in where a declared one says no.
const crawlerAccess = robotsRule(
    "robots/crawler-access/mismatch",
    "https://contentsignals.org/",
    (file, site) => {
        if (file.status === 0 || file.status >= 500) return;
        const declared = site?.["content-signals"];
        const stance = { search: "yes", ...(declared ?? servedStance(file)) } as Stance;
        const judged = Object.entries(CRAWLERS).map(([agent, purpose]) => {
            const signal = SIGNAL_OF[purpose];
            const isBlocked = isShutOut(file, agent);
            const want = signal && stance[signal];
            const isWrong = (want === "yes" && isBlocked) || (declared !== undefined && want === "no" && !isBlocked);
            log.debug({ rule: "robots/crawler-access/mismatch", url: file.url, agent, signal, want, isBlocked, isDeclared: declared !== undefined }, "crawler access judged");
            return isWrong ? `${agent} (${signal}=${want}, ${isBlocked ? "disallowed" : "allowed"})` : undefined;
        });
        const wrong = judged.filter((entry) => entry !== undefined);
        if (wrong.length === 0) return;
        return { ...said("crawler access contradicts the content signals"), locations: wrong, value: wrong, data: { [file.url]: { source: declared ? "declared" : "served" } } };
    },
    {
        title: "robots.txt access contradicts the declared content signals",
        rationale: "A crawler is shut out although the signals allow its purpose, or let in although they say no, so the content is missing from search or used for AI against the owner’s stated wishes. Skipped when robots.txt does not answer or fails with a server error.",
        fix: "Disallow / for every crawler whose signal is no, and lift the Disallow for every crawler whose signal is yes, e.g. User-agent: GPTBot then Disallow: /.",
    },
    ["site.content-signals"],
);

export const robotsRules: Record<string, Make> = {
    "robots/crawler-access/mismatch": crawlerAccess,
    "robots/root/blocked": disallowAll,
    "robots/ai-crawlers/present": aiCrawlers,
    "robots/content-signal/invalid": contentSignal,
};
