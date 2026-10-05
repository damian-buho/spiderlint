// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Facts } from "../src/facts/types.ts";
import type { Report } from "../src/index.ts";
import { rate } from "../src/report/rating.ts";
import { formatSarif } from "../src/report/sarif.ts";
import { compileRule } from "../src/rules/declarative.ts";
import { builtin } from "../src/rules/builtin.ts";
import { compileRulesets, resolveRuleset } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { byImportance, impact, interpolate, levelOf, pin } from "../src/rules/score.ts";
import type { Finding, PageRule, Rule } from "../src/rules/types.ts";

void builtin;

const schema = JSON.parse(readFileSync(new URL("fixtures/sarif-2.1.0.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

// A page whose certificate has `days` left.
function certPage(days: number): Facts {
    return { url: { href: "https://site.test/", pathname: "/", protocol: "https:" }, group: "default", tls: { cert: { "days-left": days } } } as unknown as Facts;
}

// The scored findings of one TLS rule over a page with `days` left.
function expiring(days: number, rules: Record<string, never> = {}, id = "tls/cert-expiring"): Finding[] {
    const rule = compileRulesets(["spiderlint:tls"], rules).find((candidate) => candidate.meta.id === id) as PageRule;
    return rule.check(certPage(days)) ?? [];
}

// Ten pages, one rule answering each page with the findings its path maps to.
function graded(answers: Record<string, number[]>): string | undefined {
    const rule: Rule = { meta: { id: "test/rule", severity: "warning", scope: "page", facts: [] }, check: (facts: Facts) => (answers[facts.url.pathname] ?? []).map((score) => ({ rule: "test/rule", severity: levelOf(score), score, scope: "page" as const, url: facts.url.href, message: "m" })) };
    const pages = Array.from({ length: 10 }, (_, index) => ({ url: { href: `https://site.test/${index}`, pathname: `/${index}` }, group: "default" }) as Facts);
    const { checks } = runRules(pages, new Map([["default", [rule]]]), {} as never);
    return rate({ ...checks, passed: checks.total - checks.failed }, [])?.grade;
}

function cost(scores: number[]): number {
    return scores.reduce((sum, score) => sum + (score / 5) ** 2, 0);
}

function finding(patch: Partial<Finding>): Finding {
    return { rule: "a/b", severity: "warning", score: 5, scope: "page", url: "https://site.test/", message: "m", ...patch };
}

describe("score bands", () => {
    it("derives the level from the score at every edge", () => {
        const cases: [number, string][] = [
            [0, "hint"],
            [0.9, "hint"],
            [1, "info"],
            [3.2, "info"],
            [3.3, "warning"],
            [6.5, "warning"],
            [6.6, "error"],
            [9.9, "error"],
        ];
        for (const [score, level] of cases) assert.equal(levelOf(score), level, String(score));
    });

    it("keeps a pinned score inside its band", () => {
        assert.equal(pin("warning", 9), 6.5);
        assert.equal(pin("error", 2), 6.6);
        assert.equal(pin("info", 2.5), 2.5);
    });

    it("reads a scale between its points and flat beyond them", () => {
        const scale: [number, number][] = [
            [0, 6.8],
            [2, 5.2],
        ];
        assert.equal(interpolate(scale, 1), 6);
        assert.equal(interpolate(scale, -3), 6.8);
        assert.equal(interpolate(scale, 40), 5.2);
    });
});

describe("shipped rules", () => {
    it("score every rule, in the band of the level it has always had", () => {
        const specs = Object.entries(resolveRuleset("spiderlint:all", {})).filter(([, spec]) => spec.severity !== "off");
        assert.ok(specs.length > 100);
        for (const [id, spec] of specs) {
            const { meta } = compileRule(id, spec);
            const score = meta.score ?? (meta.scale?.[0]?.[1] as number);
            assert.notEqual(score, undefined, `${id} has no score`);
            if (meta.scale === undefined) assert.equal(levelOf(score), spec.severity, `${id} changed level`);
        }
    });
});

describe("tls/cert-expiring", () => {
    it("scores higher the fewer days are left, crossing from warning into error", () => {
        const [one] = expiring(1);
        const [none] = expiring(0);
        assert.equal(one?.severity, "warning");
        assert.equal(none?.severity, "error");
        assert.ok((none?.score as number) > (one?.score as number));
    });

    it("stays in the warning band when a level pins it", () => {
        const rules = { mine: { extends: ["spiderlint:tls"], rules: { "tls/cert-expiring": "warning" } } };
        const [found] = compileRulesets(["mine"], rules as never)
            .filter((rule) => rule.meta.id === "tls/cert-expiring")
            .flatMap((rule) => (rule as PageRule).check(certPage(0)) ?? []);
        assert.equal(found?.severity, "warning");
        assert.equal(found?.score, 6.5);
    });

    it("takes a number from the config as the score and its level from the band", () => {
        const rules = { mine: { extends: ["spiderlint:tls"], rules: { "tls/cert-expiring": 2.4 } } };
        const [found] = compileRulesets(["mine"], rules as never)
            .filter((rule) => rule.meta.id === "tls/cert-expiring")
            .flatMap((rule) => (rule as PageRule).check(certPage(0)) ?? []);
        assert.equal(found?.severity, "info");
        assert.equal(found?.score, 2.4);
    });
});

describe("rating by score", () => {
    it("lowers the grade more for one high-score failure than for several low-score ones", () => {
        const one = graded({ "/0": [9] });
        const several = graded({ "/0": [3.3], "/1": [3.3], "/2": [3.3] });
        assert.equal(one, "C");
        assert.equal(several, "B");
        assert.ok(cost([9]) > cost([3.3, 3.3, 3.3]));
        assert.ok(cost([9]) > cost(Array.from({ length: 10 }, () => 1)));
    });

    it("grades a warning-only run as it always did", () => {
        assert.equal(graded({ "/0": [5], "/1": [5] }), "B");
    });
});

describe("importance", () => {
    it("counts a site-wide finding as every page and sorts by score times pages", () => {
        const site = finding({ rule: "site/rule", scope: "site", score: 5 });
        const folded = finding({ rule: "fold/rule", scope: "group", score: 5, occurrences: 5 });
        const lone = finding({ rule: "lone/rule", score: 9 });
        const sorted = [lone, folded, site].toSorted(byImportance(10)).map((one) => one.rule);
        assert.deepEqual(sorted, ["site/rule", "fold/rule", "lone/rule"]);
    });

    it("counts a site-wide finding listing URLs as those pages, impact being score times pages", () => {
        const listed = finding({ rule: "site/listed", scope: "site", score: 2, urls: ["https://site.test/a", "https://site.test/b"] });
        assert.equal(impact(listed, 50), 4);
        assert.equal(impact(finding({ rule: "site/rule", scope: "site", score: 2 }), 50), 100);
    });
});

describe("sarif score", () => {
    it("writes rank on each result and security-severity on a security rule, valid against the schema", () => {
        const findings: Finding[] = [
            { rule: "tls/authorized", severity: "error", score: 8.4, scope: "site", url: "site.test", message: "m" },
            { rule: "html/title", severity: "warning", score: 5, scope: "page", url: "https://site.test/", message: "m" },
        ];
        const sarif = JSON.parse(formatSarif({ findings, rules: {}, summary: { started: new Date().toISOString(), durationMs: 1 } } as unknown as Report));
        const rules = sarif.runs[0].tool.driver.rules as { id: string; properties?: Record<string, unknown> }[];
        assert.equal(rules.find((rule) => rule.id === "tls/authorized")?.properties?.["security-severity"], "8.4");
        assert.equal(rules.find((rule) => rule.id === "html/title")?.properties, undefined);
        assert.deepEqual(
            sarif.runs[0].results.map((result: { rank: number }) => result.rank),
            [84, 50],
        );
        assert.ok(validate(sarif), JSON.stringify(validate.errors));
    });
});
