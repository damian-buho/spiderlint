// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { linkGraph } from "../src/facts/graph.ts";
import type { Facts } from "../src/facts/types.ts";
import { audit } from "../src/index.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import type { PageRule } from "../src/rules/types.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const ORIGIN = "https://site.test";

// A stored HTML page at `path` linking to `links`.
function page(path: string, links: string[], via: "seed" | "link" = "link"): Facts {
    const url = new URL(path, ORIGIN);
    return {
        url: { href: url.href, origin: ORIGIN, protocol: "https:", host: url.host, pathname: url.pathname, search: "" },
        group: "default",
        crawl: { depth: 0, "discovered-via": via, referrers: [] },
        http: { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 1, decoded: 1 }, "content-type": "text/html" },
        html: { links: { internal: links.map((link) => new URL(link, ORIGIN).href), external: [], nofollow: [] } },
    } as unknown as Facts;
}

// Seed → a, b; a ↔ b; b → c → d → e (deep); e links nowhere; c is linked once.
const pages = [page("/", ["/a", "/b"], "seed"), page("/a", ["/", "/b"]), page("/b", ["/", "/a", "/c"]), page("/c", ["/d", "/"]), page("/d", ["/e", "/c"]), page("/e", [])];

describe("link graph", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(async () => {
        await site.close();
    });

    it("derives depth, degrees and a rank averaging 1", () => {
        const graph = linkGraph(pages);
        assert.deepEqual(graph, { pages: 6, edges: 11 });
        assert.deepEqual(pages.map((facts) => facts.graph?.depth), [0, 1, 1, 2, 3, 4]);
        assert.deepEqual(pages.map((facts) => facts.graph?.["in-degree"]), [3, 2, 2, 2, 1, 1]);
        assert.equal(pages[5]?.graph?.["out-degree"], 0);
        const mean = pages.reduce((sum, facts) => sum + (facts.graph?.rank ?? 0), 0) / pages.length;
        assert.ok(Math.abs(mean - 1) < 0.01, String(mean));
        assert.ok((pages[0]?.graph?.rank ?? 0) > (pages[5]?.graph?.rank ?? 0));
    });

    it("fails the deep page, the dead end and the weakly linked page", () => {
        linkGraph(pages);
        const rules = compileRulesets(["graph"], {}) as PageRule[];
        const found = rules.flatMap((rule) => pages.flatMap((facts) => rule.check(facts) ?? []).map((finding) => `${finding.rule} ${new URL(finding.url).pathname}`));
        assert.deepEqual(found.toSorted((a, b) => a.localeCompare(b)), ["links/click-depth /e", "links/dead-end /e", "links/weakly-linked /d", "links/weakly-linked /e"]);
    });

    it("finds only the singly linked duplicate page on the fixture site, and marks a capped crawl", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["graph"], cacheMode: "off" });
        assert.deepEqual(report.findings.map((finding) => `${finding.rule} ${new URL(finding.url).pathname}`), ["links/weakly-linked /duplicate"]);
        const capped = await audit({ seeds: [`${site.origin}/`], rules: ["graph"], cacheMode: "off", maxPages: 3 });
        assert.equal(capped.site.crawl?.complete, false);
        assert.ok(capped.findings.every((finding) => finding.message.includes("ended early")));
    });
});
