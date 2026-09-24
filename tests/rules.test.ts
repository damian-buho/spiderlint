// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT
/* eslint-disable unicorn/prefer-https -- mixed content is an http: URL by definition */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts, ResourceFacts } from "../src/facts/types.ts";
import { builtin } from "../src/rules/builtin.ts";
import { describe as describeValue } from "../src/rules/declarative.ts";
import type { AggregateRule } from "../src/rules/types.ts";

// The smallest facts document a site rule reads.
function page(href: string, resources: ResourceFacts[]): Facts {
    const url = new URL(href);
    return { url: { href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: "" }, group: "default", crawl: { depth: 0, discoveredVia: "seed", referrers: [] }, http: { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, contentType: "text/html" }, resources };
}

describe("resource rules", () => {
    it("reports an http: resource on https: pages only", () => {
        const script: ResourceFacts = { url: "http://cdn.test/a.js", kind: "script", origin: "cross", integrity: "sha384-x" };
        const rule = builtin["resources/mixed-content"]?.("error") as AggregateRule;
        const findings = rule.check([page("https://site.test/", [script]), page("https://site.test/b", [script]), page("http://site.test/c", [script])]);
        assert.equal(findings.length, 1);
        assert.equal(findings[0]?.message, "script loads over http: on 2 https: pages");
        assert.deepEqual(findings[0]?.urls, ["https://site.test/", "https://site.test/b"]);
    });

    it("accepts a cross-origin script that carries integrity", () => {
        const rule = builtin["resources/sri"]?.("warning") as AggregateRule;
        assert.deepEqual(rule.check([page("https://site.test/", [{ url: "https://cdn.test/a.js", kind: "script", origin: "cross", integrity: "sha384-x" }])]), []);
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
