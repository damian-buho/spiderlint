// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { bookRoot, rulePageUrl } from "../src/rules/book.ts";

describe("book links", () => {
    it("picks the preferred documentation link, else the first, and ends it with a slash", () => {
        const two = "links:\n  - {type: documentation, url: https://a.example/book}\n  - {type: documentation, url: https://b.example/book/, preferred: true}\n";
        assert.equal(bookRoot(two), "https://b.example/book/");
        assert.equal(bookRoot("links:\n  - {type: homepage, url: https://h.example/}\n  - {type: documentation, url: https://a.example/book}\n"), "https://a.example/book/");
    });

    it("has no root without a documentation link or links at all", () => {
        assert.equal(bookRoot("links:\n  - {type: homepage, url: https://h.example/}\n"), undefined);
        assert.equal(bookRoot("identity: {name: x}\n"), undefined);
        assert.equal(bookRoot(""), undefined);
    });

    it("links a rule to its family page anchored by its ID, in a book language else the first", () => {
        assert.equal(rulePageUrl("dns/ns/single", "uk", "https://b.example/"), "https://b.example/uk/pages/rules/dns.html#dns/ns/single");
        assert.equal(rulePageUrl("axe/image-alt", "de", "https://b.example/"), "https://b.example/en/pages/rules/axe.html#axe/image-alt");
        assert.equal(rulePageUrl("dns/ns/single", "en", ""), undefined);
    });

    it("reads the shipped projectfile’s documentation link", () => {
        const shipped = readFileSync(new URL("../projectfile.yaml", import.meta.url), "utf8");
        assert.match(bookRoot(shipped) ?? "", /^https:\/\/\S+\/$/);
        assert.match(rulePageUrl("dns/ns/single", "es") ?? "", /\/es\/pages\/rules\/dns\.html#dns\/ns\/single$/);
    });
});
