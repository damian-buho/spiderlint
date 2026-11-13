// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupsFor, parseRobots } from "../src/crawl/robots.ts";
import { stanceOf } from "../src/config/policy.ts";
import type { SiteFacts, Stance } from "../src/facts/types.ts";
import { builtin } from "../src/rules/builtin.ts";
import type { AggregateRule } from "../src/rules/types.ts";

const URL_ = "https://a.test/robots.txt";

// The findings of site rule `id` over one robots.txt body.
function judge(id: string, body: string, stance?: Stance, status = 200) {
    const rule = builtin[id]?.("warning") as AggregateRule;
    const site: SiteFacts = { sitemaps: [], robots: [parseRobots(URL_, status, body)], ...(stance && { "content-signals": stance }) };
    return rule.check([], undefined, site) ?? [];
}

describe("robots.txt", () => {
    it("joins consecutive user agents into one group and drops a rule outside any", () => {
        const facts = parseRobots(URL_, 200, "Disallow: /early\nUser-agent: A\nuser-agent: b # comment\nAllow: /x\nDisallow:\nUser-agent: c\nCrawl-delay: 2\nSitemap: https://a.test/s.xml\n");
        assert.deepEqual(facts.groups, [
            { agents: ["a", "b"], allow: ["/x"], disallow: [] },
            { agents: ["c"], allow: [], disallow: [], "crawl-delay": 2 },
        ]);
        assert.deepEqual(facts.sitemaps, ["https://a.test/s.xml"]);
    });

    it("picks the groups naming the agent, else those naming *", () => {
        const facts = parseRobots(URL_, 200, "User-agent: *\nDisallow: /a\nUser-agent: spiderlint\nDisallow: /b\n");
        assert.deepEqual(
            groupsFor(facts, "spiderlint").flatMap((group) => group.disallow),
            ["/b"],
        );
        assert.deepEqual(
            groupsFor(facts, "other").flatMap((group) => group.disallow),
            ["/a"],
        );
    });

    it("reports a blanket Disallow: / for *, and passes one with an Allow back", () => {
        assert.equal(judge("robots/root/blocked", "User-agent: *\nDisallow: /\n").length, 1);
        assert.equal(judge("robots/root/blocked", "User-agent: *\nDisallow: /\nAllow: /public/\n").length, 0);
        assert.equal(judge("robots/root/blocked", "User-agent: GPTBot\nDisallow: /\n").length, 0);
    });

    it("lists the AI crawlers a file names, with purpose and verdict", () => {
        const [finding] = judge("robots/ai-crawlers/present", "User-agent: GPTBot\nUser-agent: claude-web\nDisallow: /\nUser-agent: OAI-SearchBot\nAllow: /\n");
        assert.equal(finding?.message, "the file names AI crawlers");
        assert.deepEqual(finding?.locations, ["gptbot (training, disallowed)", "claude-web (retired, disallowed)", "oai-searchbot (search)"]);
        assert.equal(judge("robots/ai-crawlers/present", "User-agent: *\nDisallow: /private/\n").length, 0);
    });

    it("reports a Content-Signal outside the vocabulary, and passes a well-formed one", () => {
        const [finding] = judge("robots/content-signal/invalid", "User-agent: *\nContent-Signal: search=maybe, ai-train=no\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n");
        assert.deepEqual(finding?.value, ["search=maybe, ai-train=no"]);
        assert.equal(judge("robots/content-signal/invalid", "User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=no\n").length, 0);
        assert.equal(judge("robots/content-signal/invalid", "Content-Signal: training\n").length, 1);
    });

    it("reports a search engine shut out even with no stance, and nothing else", () => {
        const [finding] = judge("robots/crawler-access/mismatch", "User-agent: Googlebot\nUser-agent: GPTBot\nDisallow: /\n");
        assert.deepEqual(finding?.locations, ["googlebot (search=yes, disallowed)"]);
        assert.equal(judge("robots/crawler-access/mismatch", "User-agent: Googlebot\nDisallow: /\nAllow: /public/\n").length, 0);
    });

    it("holds a served stance to what it says yes to, and lets its no stand", () => {
        const [finding] = judge("robots/crawler-access/mismatch", "User-agent: *\nDisallow: /\nContent-Signal: search=yes, ai-input=no, ai-train=no\n");
        assert.deepEqual(finding?.locations, ["googlebot (search=yes, disallowed)", "bingbot (search=yes, disallowed)", "applebot (search=yes, disallowed)", "duckduckbot (search=yes, disallowed)", "yandexbot (search=yes, disallowed)", "baiduspider (search=yes, disallowed)"]);
        assert.equal(judge("robots/crawler-access/mismatch", "User-agent: *\nAllow: /\nContent-Signal: search=yes, ai-train=no\n").length, 0);
    });

    it("holds a declared stance both ways, and wins over the served one", () => {
        const body = "User-agent: *\nAllow: /\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\nContent-Signal: ai-train=yes\n";
        const [finding] = judge("robots/crawler-access/mismatch", body, { search: "yes", "ai-input": "yes", "ai-train": "no" });
        assert.equal(finding?.locations?.length, 7);
        assert.ok(finding?.locations?.includes("claudebot (ai-train=no, allowed)"));
        assert.ok(!finding?.locations?.some((location) => location.startsWith("gptbot")));
        assert.equal(judge("robots/crawler-access/mismatch", "User-agent: *\nAllow: /\n", { "ai-input": "yes" }).length, 0);
    });

    it("judges no file the origin failed to serve", () => {
        assert.equal(judge("robots/crawler-access/mismatch", "", { "ai-train": "no" }, 503).length, 0);
        assert.equal(judge("robots/crawler-access/mismatch", "", { "ai-train": "no" }, 404).length, 1);
    });

    it("reads a granted list as a stance on every known signal", () => {
        assert.deepEqual(stanceOf(["search", "ai-input", "x"]), { search: "yes", "ai-input": "yes", "ai-train": "no" });
        assert.deepEqual(stanceOf([]), { search: "no", "ai-input": "no", "ai-train": "no" });
        assert.equal(stanceOf({}), undefined);
    });
});
