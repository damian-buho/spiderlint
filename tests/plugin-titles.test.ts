// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translator } from "../src/i18n.ts";
import type { RuleExplanation } from "../src/rules/catalog.ts";
import { ruleSection, shippedCatalog } from "../src/rules/pages.ts";

const catalog = shippedCatalog();
const entry = (id: string) => catalog.find((rule) => rule.id === id);

describe("third-party rule titles", () => {
    it("takes each family’s title from its upstream metadata", () => {
        assert.equal(entry("axe/image-alt")?.title, "Images must have alternative text");
        assert.ok(entry("html-validate/close-order")?.title);
        assert.ok(entry("htmlhint/attr-lowercase")?.title);
        assert.ok(entry("markdownlint/heading-increment")?.title);
        assert.equal(entry("lighthouse/lcp")?.title, "LCP over 2500 ms in the lab");
    });

    it("keeps the upstream line as the fix the report shows, and the page leaves it out under the same title", () => {
        for (const id of ["axe/image-alt", "html-validate/close-order", "htmlhint/attr-lowercase"]) {
            const rule = entry(id) as RuleExplanation;
            assert.equal(rule.fix, rule.title, id);
            assert.doesNotMatch(ruleSection(rule, "axe.md", 2, new Set(), translator("en")), /^\*\*Fix\*\*$/m, id);
        }
        assert.notEqual(entry("markdownlint/heading-increment")?.fix, entry("markdownlint/heading-increment")?.title);
    });

    it("titles every rule of the upstream families", () => {
        const untitled = catalog.filter((rule) => /^(axe|htmlhint|markdownlint)\//.test(rule.id) && !rule.title).map((rule) => rule.id);
        assert.deepEqual(untitled, []);
    });
});
