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

// One crawler `/` is fetched as: its robots.txt token, product name, operator, and the UA it sends without spiderlint’s suffix.
export interface Pose {
    agent: string;
    name: string;
    operator: string;
    ua: string;
}

// The crawlers `/` is fetched as.
export const POSES: Pose[] = [
    { agent: "googlebot", name: "Googlebot", operator: "Google", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
    { agent: "bingbot", name: "Bingbot", operator: "Microsoft", ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
    { agent: "oai-searchbot", name: "OAI-SearchBot", operator: "OpenAI", ua: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)" },
    { agent: "perplexitybot", name: "PerplexityBot", operator: "Perplexity", ua: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)" },
    { agent: "chatgpt-user", name: "ChatGPT-User", operator: "OpenAI", ua: "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)" },
    { agent: "gptbot", name: "GPTBot", operator: "OpenAI", ua: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" },
    { agent: "claudebot", name: "ClaudeBot", operator: "Anthropic", ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
    { agent: "ccbot", name: "CCBot", operator: "Common Crawl", ua: "CCBot/2.0 (https://commoncrawl.org/faq/)" },
];

// A robots.txt token as its product and operator, `GPTBot (OpenAI)`; a token no pose has stays as it is.
export function crawlerName(agent: string): string {
    const pose = POSES.find((candidate) => candidate.agent === agent);
    return pose ? `${pose.name} (${pose.operator})` : agent;
}

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
        for (const { agent, ua } of POSES) {
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

// Every crawler refused `/` that spiderlint was served, where its signal says yes; a refusal by edges alone is a hint, since a verifying edge refuses our look-alike too.
const blocked: Make = (severity) => ({
    meta: { id: "crawlers/crawler/blocked", severity, scope: "site", facts: ["site.origins.*.crawlers.poses", "site.content-signals"], docs: "https://contentsignals.org/", fix: "Let the crawler through at the origin and the edge: allow verified bots in the firewall and drop any rule matching its User-Agent." },
    check(_pages, _group, site) {
        const stance = { search: "yes", ...site?.["content-signals"] } as Partial<Record<ContentSignal, "yes" | "no">>;
        return Object.entries(site?.origins ?? {}).flatMap(([subject, facts]): Finding[] => {
            const poses = (facts.crawlers as { poses?: PoseAnswer[] } | undefined)?.poses ?? [];
            const refused = poses.filter(({ agent, status }) => {
                const purpose = CRAWLERS[agent];
                const signal = purpose && SIGNAL_OF[purpose];
                const isWanted = signal !== undefined && stance[signal] === "yes";
                log.debug({ rule: "crawlers/crawler/blocked", subject, agent, status, signal, isWanted }, "crawler pose judged");
                return isWanted && status !== 0 && !isServed(status);
            });
            if (refused.length === 0) return [];
            const locations = refused.map(({ agent, status, edge }) => `${crawlerName(agent)}: ${status}${edge ? `, ${edge}` : ""}`);
            const isEdgeOnly = refused.every(({ edge }) => edge !== undefined);
            const message = said(isEdgeOnly ? "the edge refuses requests posing as crawlers the content signals welcome, as a verifying edge refuses any look-alike; check that its verified-bots setting lets the real crawlers through" : "the site refuses crawlers the content signals welcome");
            log.info({ rule: "crawlers/crawler/blocked", subject, refused: refused.length, isEdgeOnly }, "crawler refusals judged");
            return [{ rule: "crawlers/crawler/blocked", severity: isEdgeOnly ? "hint" : severity, scope: "site", url: subject, ...message, locations, value: refused }];
        });
    },
});

export default {
    name: "crawlers",
    rules: { "crawlers/crawler/blocked": blocked },
    sites: [crawlers],
    presets: {
        crawlers: {
            description: "Once per origin: fetches / as search engines and AI crawlers and holds their answers to the content signals",
            rules: { "crawlers/crawler/blocked": { severity: "warning", score: 5.1 } },
        },
    },
} satisfies Plugin;
