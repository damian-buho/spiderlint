// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT
/* eslint-disable unicorn/prefer-https -- mixed content is an http: URL by definition */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts, ResourceFacts } from "../src/facts/types.ts";
import { builtin } from "../src/rules/builtin.ts";
import { compileRule, describe as describeValue } from "../src/rules/declarative.ts";
import type { AggregateRule, PageRule, Rule } from "../src/rules/types.ts";
import { resolveRuleset } from "../src/rules/rulesets.ts";
import { exempt } from "../src/plugins/html-validate.ts";

// The smallest facts document a site rule reads.
function page(href: string, resources: ResourceFacts[]): Facts {
    const url = new URL(href);
    return { url: { href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: "" }, group: "default", crawl: { depth: 0, "discovered-via": "seed", referrers: [] }, http: { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, "content-type": "text/html" }, resources };
}

// A same-origin resource that answered 200.
function served(url: string, kind: ResourceFacts["kind"], type: string, headers: Record<string, string>, body = 4096): ResourceFacts {
    return { url, kind, origin: "same", http: { status: 200, headers, "content-type": type, size: { body }, timing: {} } };
}

describe("resource rules", () => {
    it("reports an http: resource on https: pages only", () => {
        const script: ResourceFacts = { url: "http://cdn.test/a.js", kind: "script", origin: "cross", integrity: "sha384-x" };
        const rule = builtin["resources/mixed-content"]?.("error") as AggregateRule;
        const findings = rule.check([page("https://site.test/", [script]), page("https://site.test/b", [script]), page("http://site.test/c", [script])]) ?? [];
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.message, "script loads over http: on 2 https: pages");
        assert.deepEqual(findings[0]?.urls, ["https://site.test/", "https://site.test/b"]);
    });

    it("accepts a cross-origin script that carries integrity", () => {
        const rule = builtin["resources/sri"]?.("warning") as AggregateRule;
        assert.deepEqual(rule.check([page("https://site.test/", [{ url: "https://cdn.test/a.js", kind: "script", origin: "cross", integrity: "sha384-x" }])]), []);
    });

    it("wants a year of max-age on a fingerprinted or immutable asset only", () => {
        const resources = [
            served("https://site.test/_astro/index.Bx1kQ2_9.js", "script", "text/javascript", { "cache-control": "max-age=3600" }),
            served("https://site.test/app-3f2a9c1b.js", "script", "text/javascript", {}),
            served("https://site.test/lib.js", "script", "text/javascript", { "cache-control": "max-age=60, immutable" }),
            served("https://site.test/main.4e5f6a7b.js", "script", "text/javascript", { "cache-control": "public, max-age=31536000, immutable" }),
            served("https://site.test/analytics-tracking.js", "script", "text/javascript", { "cache-control": "no-cache" }),
        ];
        const rule = builtin["resources/cache-control"]?.("warning") as AggregateRule;
        const findings = rule.check([page("https://site.test/", resources)]) ?? [];
        assert.deepEqual(findings.map((finding) => finding.url), resources.slice(0, 3).map((resource) => resource.url));
        assert.match(findings[1]?.message ?? "", /^fingerprinted script is cached for 0 s \(Cache-Control: absent\)/);
    });

    it("wants a text asset over 1 KB compressed, and leaves WOFF2 and small files alone", () => {
        const resources = [served("https://site.test/a.css", "style", "text/css", {}), served("https://site.test/f.ttf", "style", "font/ttf", { "content-encoding": "identity" }), served("https://site.test/b.css", "style", "text/css", { "content-encoding": "br" }), served("https://site.test/f.woff2", "style", "font/woff2", {}), served("https://site.test/c.css", "style", "text/css", {}, 512)];
        const rule = builtin["resources/compression"]?.("warning") as AggregateRule;
        const findings = rule.check([page("https://site.test/", resources)]) ?? [];
        assert.deepEqual(findings.map((finding) => [finding.url, finding.message]), [
            ["https://site.test/a.css", "text/css style is served uncompressed; used by 1 pages"],
            ["https://site.test/f.ttf", "font/ttf style is served identity; used by 1 pages"],
        ]);
    });
});

describe("resource hints", () => {
    it("judges an unused preconnect on a rendered page only", () => {
        const links = [{ rel: "preconnect", href: "https://cdn.test/" }, { rel: "dns-prefetch", href: "https://gone.test/" }];
        const statik = { ...page("https://site.test/", [{ url: "https://cdn.test/a.js", kind: "script", origin: "cross" }]), html: { head: { links } } as Facts["html"] };
        const rendered: Facts = { ...statik, browser: { timing: {}, console: { errors: [], warnings: [] }, weight: {}, cookies: [] } };
        const rule = builtin["html/preconnect-unused"]?.("info") as PageRule;
        assert.equal(rule.check(statik), undefined);
        assert.deepEqual(rule.check(rendered)?.map((finding) => finding.message), ["rel=dns-prefetch warms https://gone.test, which no resource of the page loads"]);
    });
});

describe("finding value", () => {
    it("shows a 61-character title whole", () => {
        const title = "Deployed Reseed server for I2P on Kiota | Seconds to Midnight";
        assert.equal(describeValue(title), `61 characters: “${title}”`);
    });

    it("keeps both ends of a long string around one ellipsis", () => {
        const got = describeValue(`a${"x".repeat(298)}z`);
        assert.match(got, /^300 characters: “ax+…x+z”$/);
        assert.equal(got.length - "300 characters: “”".length, 200);
    });
});

describe("rule fixes", () => {
    const all = resolveRuleset("spiderlint:all", {});
    const exemptList = new Set(exempt);

    for (const [id, spec] of Object.entries(all)) {
        it(`rule ${id} has a fix`, () => {
            if (exemptList.has(id)) return;
            const rule = compileRule(id, spec) as Rule;
            assert.ok(rule.meta.fix, `rule ${id} is missing a fix`);
            assert.ok(!rule.meta.fix.includes("\n"), `rule ${id} has a multi-line fix`);
            if (!/^(axe|htmlhint|html-validate)\//.test(id)) assert.match(rule.meta.fix, /^[^a-z].*[.?!]$/su, `rule ${id} fix is not a sentence`);
        });
    }
});
