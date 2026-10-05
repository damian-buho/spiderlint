// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const TIGHT = { tight: { extends: ["green/page-weight-co2"], rules: { "green/page-weight-co2": { expect: { maximum: 0.000001 } } } } };

describe("co2 per view", () => {
    let site: Fixture;
    let first: Report;
    let second: Report;

    before(async () => {
        site = await serveFixture();
        const options = { seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, cacheMode: "off" as const };
        first = await audit({ ...options, rules: ["green/page-weight-co2"] });
        second = await audit({ ...options, rulesets: TIGHT, rules: ["tight"] });
    });
    after(() => site.close());

    it("pins the model and gives the same figure on every run", () => {
        const [one, two] = [first.pages[0]?.co2, second.pages[0]?.co2];
        assert.deepEqual([one?.model, one?.version, one?.library], ["swd", 4, "@tgwf/co2 0.19.0"]);
        assert.ok((one?.grams ?? 0) > 0 && (one?.bytes ?? 0) > (first.pages[0]?.http.size.body ?? 0), JSON.stringify(one));
        assert.deepEqual(two, one);
    });

    it("passes a light page and fails it under a tighter budget a ruleset sets", () => {
        assert.deepEqual(first.findings, []);
        assert.deepEqual(
            second.findings.map((finding) => finding.rule),
            ["green/page-weight-co2"],
        );
    });
});
