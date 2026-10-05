// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import { serveW3C, W3C_CASES } from "./fixtures/w3c-feeds.ts";

// W3C messages no `feeds/*` rule judges, with why; every vendored case
// without a rule must name one of these, so none is skipped silently.
const UNCOVERED: Record<string, string> = {
    "ContainsHTML{parent:channel,element:title}": "channel titles are not judged, only item titles carry feeds/title-markup",
};

describe("w3c feedvalidator sample", () => {
    let origin = "";
    let site: { origin: string; close(): Promise<void> } | undefined;
    let report: Report;

    before(async () => {
        site = await serveW3C();
        origin = site.origin;
        report = await audit({ seeds: [`${origin}/`], rules: ["feeds"], sitemap: false, robots: false, cacheMode: "off" });
    });

    after(() => site?.close());

    it("fires a feeds rule everywhere the validator fires, naming the rest", () => {
        assert.ok(
            W3C_CASES.some((item) => item.rule === undefined),
            "the sample keeps at least one uncovered case",
        );
        for (const entry of W3C_CASES) {
            if (entry.rule === undefined) {
                assert.ok(UNCOVERED[entry.expects], `${entry.source} expects ${entry.expects} with no rule and no uncovered reason`);
                continue;
            }
            const fired = report.findings.filter((finding) => finding.url === `${origin}${entry.path}`).map((finding) => finding.rule);
            assert.ok(fired.includes(entry.rule), `${entry.source} expects ${entry.expects} but ${entry.rule} never fired (fired: ${fired.join(", ") || "nothing"})`);
        }
    });
});
