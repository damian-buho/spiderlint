// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { botAgent, userAgent } from "../src/agent.ts";
import { edgeOf, wallOf, type Probe, type ProbeInit } from "../src/crawl/probe.ts";
import type { SiteFacts, Stance } from "../src/facts/types.ts";
import crawlers, { POSES, type PoseAnswer } from "../src/plugins/crawlers.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import { CRAWLERS } from "../src/rules/robots.ts";
import type { AggregateRule } from "../src/rules/types.ts";

const ORIGIN = "https://a.test";

// An answer with `status`, `headers` and `body`.
function answer(status: number, headers: Record<string, string> = {}, body = ""): Probe {
    return { url: `${ORIGIN}/`, status, headers, body, redirects: [], ms: 1 };
}

// The findings of crawlers/blocked over one origin’s poses and a stance.
function judge(poses: PoseAnswer[], stance?: Stance) {
    const rule = crawlers.rules["crawlers/blocked"]("warning") as AggregateRule;
    const site: SiteFacts = { sitemaps: [], origins: { [ORIGIN]: { crawlers: { url: `${ORIGIN}/`, status: 200, poses } } }, ...(stance && { "content-signals": stance }) };
    return rule.check([], undefined, site) ?? [];
}

describe("crawlers", () => {
    it("poses only as tokens the robots table knows, each UA keeping spiderlint’s own", () => {
        for (const [agent] of POSES) assert.ok(Object.hasOwn(CRAWLERS, agent), agent);
        assert.ok(botAgent("CCBot/2.0").startsWith("CCBot/2.0 "));
        assert.ok(botAgent("CCBot/2.0").endsWith(userAgent()));
    });

    it("names the edge behind a challenge or block page, and none for the origin’s own refusal", () => {
        assert.equal(edgeOf(answer(403, { "cf-mitigated": "challenge" })), "cloudflare");
        assert.equal(edgeOf(answer(403, { server: "cloudflare" })), "cloudflare");
        assert.equal(edgeOf(answer(200, { server: "cloudflare" })), undefined);
        assert.equal(edgeOf(answer(403, { "x-datadome": "protected" })), "datadome");
        assert.equal(edgeOf(answer(403, {}, "Request unsuccessful. Incapsula incident ID: 1")), "imperva");
        assert.equal(edgeOf(answer(202, { "x-amzn-waf-action": "challenge" })), "aws-waf");
        assert.equal(edgeOf(answer(403, { server: "AkamaiGHost" })), "akamai");
        assert.equal(edgeOf(answer(402, { "akamai-x-true-cache-ttl": "-1" })), "akamai");
        assert.equal(edgeOf(answer(200, { "akamai-x-true-cache-ttl": "-1" })), undefined);
        assert.equal(edgeOf(answer(401, { server: "cloudflare" })), undefined);
        assert.equal(edgeOf(answer(403, { server: "nginx" })), undefined);
    });

    it("calls a page walled only by marks a block or challenge carries, never a site’s own refusal behind its edge", () => {
        assert.equal(wallOf(answer(403, { "cf-mitigated": "challenge" })), "cloudflare");
        assert.equal(wallOf(answer(403, { server: "cloudflare", "server-timing": "cfEdge;dur=14,cfOrigin;dur=0" })), "cloudflare");
        assert.equal(wallOf(answer(403, { server: "cloudflare", "server-timing": "cfEdge;dur=14,cfOrigin;dur=90" })), undefined);
        assert.equal(wallOf(answer(401, { "x-datadome": "protected", "x-dd-b": "1" })), "datadome");
        assert.equal(wallOf(answer(404, { "x-datadome": "protected", "x-dd-b": "1" })), undefined);
        assert.equal(wallOf(answer(403, { "x-datadome": "protected" })), undefined);
        assert.equal(wallOf(answer(404, { "x-iinfo": "1" })), undefined);
        assert.equal(wallOf(answer(403, {}, "Request unsuccessful. Incapsula incident ID: 1")), "imperva");
        assert.equal(wallOf(answer(202, { "x-amzn-waf-action": "challenge" })), "aws-waf");
        assert.equal(wallOf(answer(503, { server: "AkamaiGHost" })), "akamai");
        assert.equal(wallOf(answer(404, { server: "AkamaiGHost" })), undefined);
        assert.equal(wallOf(answer(402, { "akamai-x-true-cache-ttl": "-1" })), "akamai");
        assert.equal(wallOf(answer(402)), "unknown");
        assert.equal(wallOf(answer(401)), undefined);
    });

    it("fetches / as each crawler with its UA, and none when spiderlint itself is refused", async () => {
        const seen: (string | undefined)[] = [];
        const context = {
            fetch: async (_url: string, init: ProbeInit = {}) => {
                seen.push(init.as);
                return init.as?.includes("GPTBot") ? answer(403, { "cf-mitigated": "challenge" }) : answer(200);
            },
        } as unknown as SiteContext;
        const extractor = crawlers.sites[0];
        const facts = (await extractor?.extract(ORIGIN, context)) as { poses: PoseAnswer[] };
        assert.deepEqual(seen, [undefined, ...POSES.map(([, ua]) => ua)]);
        assert.deepEqual(
            facts.poses.filter(({ status }) => status !== 200),
            [{ agent: "gptbot", status: 403, edge: "cloudflare" }],
        );
        const refused = { fetch: async () => answer(503) } as unknown as SiteContext;
        assert.deepEqual(await extractor?.extract(ORIGIN, refused), { url: `${ORIGIN}/`, status: 503, poses: [] });
    });

    it("reports a refused search engine with no stance, and an AI crawler only where its signal is yes", () => {
        const poses: PoseAnswer[] = [
            { agent: "googlebot", status: 403 },
            { agent: "gptbot", status: 403, edge: "cloudflare" },
            { agent: "oai-searchbot", status: 200 },
        ];
        const [plain] = judge(poses);
        assert.deepEqual(plain?.locations, ["googlebot (403)"]);
        assert.equal(plain?.message, "the site refuses crawlers the content signals welcome");
        const [edge] = judge([{ agent: "gptbot", status: 403, edge: "cloudflare" }], { "ai-train": "yes" });
        assert.deepEqual(edge?.locations, ["gptbot (403, cloudflare)"]);
        assert.match(edge?.message ?? "", /may only refuse look-alikes/);
        assert.equal(judge(poses, { search: "no", "ai-train": "no" }).length, 0);
        assert.equal(judge([{ agent: "googlebot", status: 0, error: "timeout" }]).length, 0);
        assert.equal(
            judge([
                { agent: "googlebot", status: 299 },
                { agent: "bingbot", status: 300 },
            ]).length,
            1,
        );
    });
});
