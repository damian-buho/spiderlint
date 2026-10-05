// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { po } from "gettext-parser";
import { chromium } from "playwright";
import { audit, type Report } from "../src/index.ts";
import { isBrowserFact } from "../src/plugins/index.ts";
import { compileRulesets, resolveRuleset } from "../src/rules/rulesets.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

// The msgids of a language’s catalog.
function catalog(lang: string): Set<string> {
    const parsed = po.parse(readFileSync(new URL(`../locales/${lang}/LC_MESSAGES/messages.po`, import.meta.url)));
    return new Set(Object.keys(parsed.translations[""] ?? {}));
}

const byName = (a: string, b: string) => a.localeCompare(b);

// Rules that read a rendered page, which needs a Chromium the npm-test container does not launch.
const browserRules = compileRulesets(["all"], {})
    .filter((rule) => rule.meta.facts.some((fact) => isBrowserFact(fact)))
    .map((rule) => rule.meta.id);

// Every finding of a report carries a template with a msgid in every catalog.
function templates(report: Report): void {
    const plain = report.findings.filter((finding) => finding.text === undefined).map((finding) => `${finding.rule}: ${finding.message}`);
    assert.deepEqual([...new Set(plain)].toSorted(byName), [], "findings still written as plain messages");
    const texts = new Set(report.findings.flatMap((finding) => (finding.text === undefined ? [] : [finding.text])));
    for (const lang of ["es", "uk"]) {
        const known = catalog(lang);
        assert.deepEqual([...texts.difference(known)].toSorted(byName), [], `${lang} catalog lacks these texts`);
    }
}

describe("rule sentences", () => {
    it("has a msgid in every catalog for each rule’s message", () => {
        const messages = new Set(Object.values(resolveRuleset("all", {})).flatMap((spec) => (spec.message === undefined ? [] : [spec.message])));
        for (const lang of ["es", "uk"]) {
            const known = catalog(lang);
            assert.deepEqual([...messages.difference(known)].toSorted(byName), [], `${lang} catalog lacks these messages`);
        }
    });
});

describe("finding templates", () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["all"] } }, excludeRules: browserRules });
    });

    after(() => site.close());

    it("gives every finding a template with a msgid in every catalog", () => {
        templates(report);
    });
});

// The node tool image carries no Chromium libraries; like tests/browser.test.ts, this runs where a browser launches.
async function launchFailure(): Promise<string | false> {
    try {
        const browser = await chromium.launch();
        await browser.close();
        return false;
    } catch (error) {
        return `chromium does not launch: ${String(error).split("\n", 1)[0]}`;
    }
}

describe("finding templates in a browser", { skip: await launchFailure() }, () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["all"] } }, excludeRules: ["lighthouse/*"] });
    });

    after(() => site.close());

    it("gives every browser finding a template with a msgid in every catalog", () => {
        templates(report);
    });
});
