// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "../src/facts/types.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import type { AggregateRule, RulesetConfig } from "../src/rules/types.ts";

// A 2xx response at `path` sent with `policy` as its Cache-Control.
function served(path: string, policy: string, type = "application/pdf", resources: Facts["resources"] = []): Facts {
    const url = new URL(path, "https://site.test");
    return {
        url: { href: url.href, origin: url.origin, protocol: "https:", host: url.host, pathname: url.pathname, search: url.search },
        group: "default",
        crawl: { depth: 1, "discovered-via": "link", referrers: ["https://site.test/"] },
        http: { status: 200, redirects: [], headers: { "cache-control": policy }, timing: {}, cookies: [], size: { body: 1, decoded: 1 }, "content-type": type },
        resources,
    };
}

// The rule as `performance` ships it, or with `expect` as a projectfile sets it.
function judge(pages: Facts[], expect?: Record<string, unknown>) {
    const rulesets: Record<string, RulesetConfig> = expect ? { custom: { extends: ["spiderlint:performance"], rules: { "caching/long-without-hash": { expect } } } } : {};
    const rule = compileRulesets([expect ? "custom" : "performance"], rulesets).find((entry) => entry.meta.id === "caching/long-without-hash") as AggregateRule;
    return rule.check(pages) ?? [];
}

const YEAR = "public, max-age=31536000, immutable";

describe("caching/long-without-hash", () => {
    it("reports an immutable file at a fixed URL as an error, and passes it once the URL carries a version or hash", () => {
        const [finding, ...rest] = judge([served("/cv.pdf", YEAR)]);
        assert.deepEqual(rest, []);
        assert.equal(finding?.severity, "error");
        assert.equal(finding?.message, "application/pdf files are sent immutable at URLs that carry no hash or version, so caches serve a stale copy after the next publish");
        assert.deepEqual(finding?.data, { "https://site.test/cv.pdf": { "cache-control": YEAR, pages: 1 } });
        assert.deepEqual(judge([served("/cv.pdf?v=20261007", YEAR), served("/cv.3f9a1c.pdf", YEAR), served("/_astro/index.BjkK2l1x.css", YEAR, "text/css")]), []);
    });

    it("raises nothing on no-cache or a short max-age at a plain URL", () => {
        assert.deepEqual(judge([served("/", "no-cache", "text/html"), served("/about", "public, max-age=3600", "text/html"), served("/a.pdf", "no-cache, immutable")]), []);
    });

    it("groups URLs by file type, counts the pages loading a resource, and warns on a long max-age", () => {
        const logo = { url: "https://cdn.test/logo.png", kind: "image" as const, origin: "cross" as const, http: { status: 200, headers: { "cache-control": "max-age=31536000" }, timing: {}, size: { body: 1 }, "content-type": "image/png" } };
        const found = judge([served("/a", "no-cache", "text/html", [logo]), served("/b", "no-cache", "text/html", [logo]), served("/x.pdf", "s-maxage=31536000"), served("/y.pdf", "max-age=31536000")]);
        assert.deepEqual(
            found.map((finding) => [finding.severity, finding.value, finding.urls]),
            [
                ["warning", "application/pdf", ["https://site.test/x.pdf", "https://site.test/y.pdf"]],
                ["warning", "image/png", ["https://cdn.test/logo.png"]],
            ],
        );
        assert.deepEqual(found[1]?.data?.["https://cdn.test/logo.png"], { "cache-control": "max-age=31536000", pages: 2 });
    });

    it("follows the threshold, extra entropy patterns and the allow-list a projectfile sets", () => {
        const week = [served("/a.pdf", "max-age=604800")];
        assert.deepEqual(judge(week), []);
        assert.equal(judge(week, { threshold: 86_400 }).length, 1);
        assert.deepEqual(judge([served("/release/a.pdf", YEAR)], { entropy: ["/release/**"] }), []);
        assert.deepEqual(judge([served("/fonts/inter.woff2", YEAR, "font/woff2")], { allow: ["re:^/fonts/"] }), []);
    });
});
