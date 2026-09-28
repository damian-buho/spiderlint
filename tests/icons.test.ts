// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import type { Origin } from "./fixtures/origin.ts";
import { serveIcons } from "./fixtures/icons.ts";

// The message of each finding, by rule.
function byRule(report: Report): Record<string, string> {
    return Object.fromEntries(report.findings.map((finding) => [finding.rule, finding.message]));
}

describe("icons plugin", () => {
    let good: Origin;
    let bad: Origin;

    before(async () => {
        [good, bad] = await Promise.all([serveIcons("good"), serveIcons("bad")]);
    });

    after(() => Promise.all([good.close(), bad.close()]));

    it("passes an origin whose every icon is present, well-formed and the size it declares", async () => {
        const report = await audit({ seeds: [`${good.origin}/`], rules: ["icons"], cacheMode: "off" });
        assert.deepEqual(byRule(report), {});
        assert.equal(report.summary.checks.total, 4, "every icons rule but the two hints judged the origin");
        assert.equal(good.requested.filter((path) => path === "/favicon.ico").length, 1, "each icon is fetched once");
    });

    it("gives one finding per defect family on a broken origin", async () => {
        const report = await audit({ seeds: [`${bad.origin}/`], rules: ["icons"], cacheMode: "off" });
        const found = byRule(report);
        assert.deepEqual(Object.keys(found).toSorted((a, b) => a.localeCompare(b)), ["icons/apple-touch", "icons/declared-size", "icons/ms-tile", "icons/svg"]);
        assert.match(found["icons/apple-touch"] ?? "", /1 pages link no apple-touch-icon and \S+\/apple-touch-icon\.png answers 404/);
        assert.match(found["icons/declared-size"] ?? "", /touch\.png declares 180x180 but is 16x16.*512\.png declares 512x512 but is 256x256/);
        assert.match(found["icons/ms-tile"] ?? "", /missing-tile\.png answers 404/);
        assert.match(found["icons/svg"] ?? "", /icon\.svg is linked without type/);
    });
});
