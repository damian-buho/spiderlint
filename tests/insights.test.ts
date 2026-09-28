// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "../src/facts/types.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import type { AggregateRule } from "../src/rules/types.ts";

// A 2xx page with HTTP `version`, a total time of `total` ms and a body of `body` bytes.
function page(index: number, version: string, total: number, body = 1000): Facts {
    const href = `https://site.test/p/${index}`;
    return { url: { href, origin: "https://site.test", protocol: "https:", host: "site.test", pathname: `/p/${index}`, search: "" }, group: "default", crawl: { depth: 1, "discovered-via": "link", referrers: [] }, http: { status: 200, version, redirects: [], headers: {}, timing: { total }, cookies: [], size: { body, decoded: body }, "content-type": "text/html" }, resources: [] };
}

// `count` pages over HTTP/3 with timings around 100 ms, the second over HTTP/2 and the third 20 times slower.
function site(count: number): Facts[] {
    return Array.from({ length: count }, (_, index) => page(index, index === 1 ? "2.0" : "3.0", index === 2 ? 2000 : 95 + (index % 7) * 2));
}

// The insights preset’s findings over `pages`.
function insights(pages: Facts[]) {
    const rules = compileRulesets(["insights"], {});
    return runRules(pages, new Map([["default", rules]]), { sitemaps: [] }).findings;
}

describe("insights", () => {
    it("names the one HTTP/2 page among HTTP/3 pages and the one page 20 times slower, and nothing else", () => {
        const found = insights(site(25));
        assert.deepEqual(found.map((finding) => [finding.rule, finding.severity, finding.urls]), [
            ["insight/numeric-outlier", "info", ["https://site.test/p/2"]],
            ["insight/minority-value", "info", ["https://site.test/p/1"]],
        ]);
        assert.match(found[0]?.message ?? "", /^http\.timing\.total stands far above the median 101 of 25 pages: https:\/\/site\.test\/p\/2 2000 \(19\.8×\); .* alone outweighs the next 10 pages combined$/);
        assert.equal(found[1]?.message, "http.version is 3.0 on 24 of 25 pages, but 2.0 on https://site.test/p/1");
    });

    it("stays quiet on a site of 5 pages", () => {
        assert.deepEqual(insights(site(5)), []);
    });

    it("keeps quiet when most values are equal and one differs a little, then flags a far one", () => {
        const rule = compileRulesets(["insight/numeric-outlier"], {})[0] as AggregateRule;
        const flat = Array.from({ length: 20 }, (_, index) => page(index, "3.0", 100, index === 0 ? 1100 : 1000));
        assert.deepEqual(rule.check(flat), []);
        flat[0] = page(0, "3.0", 100, 50_000);
        assert.deepEqual(rule.check(flat)?.map((finding) => finding.url), ["https://site.test/p/0"]);
    });

    it("compares 2xx pages only, and takes its facts and bounds from expect", () => {
        const pages = site(25);
        for (const facts of pages.slice(3, 10)) facts.http.status = 404;
        assert.deepEqual(insights(pages), []);
        const rule = compileRulesets(["custom"], { custom: { rules: { "insight/minority-value": { expect: { facts: ["http.version"], share: 0.2, "min-pages": 5 } } } } })[0] as AggregateRule;
        assert.deepEqual(rule.check(site(5))?.map((finding) => finding.urls), [["https://site.test/p/1"]]);
    });
});
