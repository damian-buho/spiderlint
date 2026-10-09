// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "../src/facts/types.ts";
import { rate } from "../src/report/rating.ts";
import { runRules } from "../src/rules/run.ts";
import type { Finding, Rule } from "../src/rules/types.ts";

function checks(passed: number, total: number, errored = 0) {
    return { total, passed, failed: total - passed, errored };
}

function page(pathname: string): Facts {
    return { url: { href: `https://site.test${pathname}`, pathname }, group: "default", crawl: {}, http: {} } as Facts;
}

function finding(url: string, severity: Finding["severity"]): Finding {
    return { rule: "test/rule", severity, scope: "page", url, group: "default", message: "m" };
}

// A page rule answering from a table keyed by pathname; an absent path is a `when`-skip.
function pageRule(answers: Record<string, Finding["severity"][]>): Rule {
    return { meta: { id: "test/rule", severity: "error", scope: "page", facts: [] }, check: (facts: Facts) => answers[facts.url.pathname]?.map((severity) => finding(facts.url.href, severity)) };
}

describe("rating", () => {
    it("grades by the share of checks passed, boundaries inclusive", () => {
        const cases: [number, number, string][] = [
            [100, 100, "S"],
            [999, 1000, "A"],
            [90, 100, "A"],
            [899, 1000, "B"],
            [63, 90, "B"],
            [70, 100, "B"],
            [60, 100, "C"],
            [40, 100, "D"],
            [20, 100, "E"],
            [199, 1000, "F"],
            [0, 100, "F"],
        ];
        for (const [passed, total, grade] of cases) assert.equal(rate(checks(passed, total), [])?.grade, grade, `${passed} of ${total}`);
    });

    it("caps a run with an error at B", () => {
        assert.equal(rate(checks(999, 1000, 1), [])?.grade, "B");
        assert.equal(rate(checks(60, 100, 1), [])?.grade, "C");
    });

    it("gives no grade when nothing was judged", () => {
        assert.equal(rate(checks(0, 0), ["seo"]), undefined);
    });
});

describe("checks", () => {
    it("counts a page once however many findings it has, passes info, skips when-guarded pages", () => {
        const rule = pageRule({ "/a": [], "/b": ["error", "error", "warning"], "/c": ["info"], "/e": ["warning"] });
        const run = runRules([page("/a"), page("/b"), page("/c"), page("/d"), page("/e")], new Map([["default", [rule]]]), {} as never);
        assert.deepEqual(run.checks, { total: 4, failed: 2, errored: 1, cost: 3.56 });
        assert.deepEqual(run.perRule.get("test/rule"), { checks: 4, failed: 2, pages: 4 });
    });

    it("counts nothing for a group without pages", () => {
        const run = runRules([], new Map([["default", [pageRule({})]]]), {} as never);
        assert.deepEqual(run.checks, { total: 0, failed: 0, errored: 0, cost: 0 });
    });
});
