// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { po } from "gettext-parser";
import { resolveRuleset } from "../src/rules/rulesets.ts";

// The msgids of a language’s catalog.
function catalog(lang: string): Set<string> {
    const parsed = po.parse(readFileSync(new URL(`../locales/${lang}/LC_MESSAGES/messages.po`, import.meta.url)));
    return new Set(Object.keys(parsed.translations[""] ?? {}));
}

describe("rule sentences", () => {
    it("has a msgid in every catalog for each rule’s message", () => {
        const messages = new Set(Object.values(resolveRuleset("all", {})).flatMap((spec) => (spec.message === undefined ? [] : [spec.message])));
        for (const lang of ["es", "uk"]) {
            const known = catalog(lang);
            assert.deepEqual(
                [...messages.difference(known)].toSorted((a, b) => a.localeCompare(b)),
                [],
                `${lang} catalog lacks these messages`,
            );
        }
    });
});
