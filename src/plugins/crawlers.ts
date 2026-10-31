// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { edgeOf } from "../crawl/probe.ts";
import type { ContentSignal } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "../rules/message.ts";
import { CRAWLERS, SIGNAL_OF } from "../rules/robots.ts";
import type { Finding, Make } from "../rules/types.ts";
import type { Plugin, SiteExtractor } from "./types.ts";

// The crawlers `/` is fetched as: robots.txt token, then the UA it sends without spiderlint’s suffix.
export const POSES: [string, string][] = [
    ["googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
    ["bingbot", "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"],
    ["oai-searchbot", "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)"],
    ["perplexitybot", "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"],
    ["chatgpt-user", "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)"],
    ["gptbot", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"],
    ["claudebot", "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"],
    ["ccbot", "CCBot/2.0 (https://commoncrawl.org/faq/)"],
];

// One crawler’s answer: its status, and the edge whose challenge or block page it got.
export interface PoseAnswer {
    agent: string;
    status: number;
    edge?: string;
    error?: string;
}

// Whether an answer is a 2xx page.
function isServed(status: number): boolean {
    return status >= 200 && status <= 299;
}

// `/` as spiderlint, then as each crawler; a crawler is judged only where spiderlint itself was served.
const crawlers: SiteExtractor = {
    id: "crawlers",
    per: "origin",
    version: "1",
    timeout: 180_000,
    async extract(origin, context) {
        const url = `${origin}/`;
        const baseline = await context.fetch(url, { redirect: "follow" });
        log.debug({ url, status: baseline.status }, "baseline for crawler poses probed");
        if (!isServed(baseline.status)) return { url, status: baseline.status, poses: [] };
        const poses: PoseAnswer[] = [];
        for (const [agent, ua] of POSES) {
            try {
                const answer = await context.fetch(url, { redirect: "follow", as: ua });
                const edge = edgeOf(answer);
                log.debug({ url, agent, status: answer.status, edge }, "crawler pose probed");
                poses.push({ agent, status: answer.status, ...(edge && { edge }) });
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                log.debug({ url, agent, error: reason }, "crawler pose failed");
                poses.push({ agent, status: 0, error: reason });
            }
        }
        return { url, status: baseline.status, poses };
    },
};

// Every crawler refused `/` that spiderlint was served, where its signal says yes; an edge’s refusal may be its check on look-alike crawlers.
const blocked: Make = (severity) => ({
    meta: { id: "crawlers/blocked", severity, scope: "site", facts: ["site.origins.*.crawlers.poses", "site.content-signals"], docs: "https://contentsignals.org/", fix: "Let the crawler through at the origin and the edge: allow verified bots in the firewall and drop any rule matching its User-Agent." },
    check(_pages, _group, site) {
        const stance = { search: "yes", ...site?.["content-signals"] } as Partial<Record<ContentSignal, "yes" | "no">>;
        return Object.entries(site?.origins ?? {}).flatMap(([subject, facts]): Finding[] => {
            const poses = (facts.crawlers as { poses?: PoseAnswer[] } | undefined)?.poses ?? [];
            const refused = poses.filter(({ agent, status }) => {
                const purpose = CRAWLERS[agent];
                const signal = purpose && SIGNAL_OF[purpose];
                const isWanted = signal !== undefined && stance[signal] === "yes";
                log.debug({ rule: "crawlers/blocked", subject, agent, status, signal, isWanted }, "crawler pose judged");
                return isWanted && status !== 0 && !isServed(status);
            });
            if (refused.length === 0) return [];
            const locations = refused.map(({ agent, status, edge }) => `${agent} (${status}${edge ? `, ${edge}` : ""})`);
            const isEdgeOnly = refused.every(({ edge }) => edge !== undefined);
            const message = said(isEdgeOnly ? "the edge refuses crawlers the content signals welcome; it may only refuse look-alikes" : "the site refuses crawlers the content signals welcome");
            return [{ rule: "crawlers/blocked", severity, scope: "site", url: subject, ...message, locations, value: refused }];
        });
    },
});

export default {
    name: "crawlers",
    rules: { "crawlers/blocked": blocked },
    sites: [crawlers],
    presets: {
        crawlers: {
            description: "Once per origin: fetches / as search engines and AI crawlers and holds their answers to the content signals",
            rules: { "crawlers/blocked": { severity: "warning", score: 5.1 } },
        },
    },
} satisfies Plugin;
