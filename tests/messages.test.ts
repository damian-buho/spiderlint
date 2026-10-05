// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { po } from "gettext-parser";
import { audit, type Report } from "../src/index.ts";
import { resolveRuleset } from "../src/rules/rulesets.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

// The msgids of a language’s catalog.
function catalog(lang: string): Set<string> {
    const parsed = po.parse(readFileSync(new URL(`../locales/${lang}/LC_MESSAGES/messages.po`, import.meta.url)));
    return new Set(Object.keys(parsed.translations[""] ?? {}));
}

const byName = (a: string, b: string) => a.localeCompare(b);

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
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["all"] } }, excludeRules: ["lighthouse/*", "axe/*", "browser/*"] });
    });

    after(() => site.close());

    it("gives every finding a template with a msgid in every catalog", () => {
        const plain = report.findings.filter((finding) => finding.text === undefined).map((finding) => `${finding.rule}: ${finding.message}`);
        assert.deepEqual([...new Set(plain)].toSorted(byName), [], "findings still written as plain messages");
        const texts = new Set(report.findings.flatMap((finding) => (finding.text === undefined ? [] : [finding.text])));
        for (const lang of ["es", "uk"]) {
            const known = catalog(lang);
            assert.deepEqual([...texts.difference(known)].toSorted(byName), [], `${lang} catalog lacks these texts`);
        }
    });
});
