// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import { serveOrigin, type Origin } from "./fixtures/origin.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { serveWellKnown } from "./fixtures/well-known.ts";

const EXCLUDE = ["/tmp/**"];

// Rule IDs of a report’s findings, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("well-known plugin", () => {
    let site: Fixture;
    let valid: Origin;
    let broken: Origin;
    let soft: Origin;

    before(async () => {
        [site, valid, broken, soft] = await Promise.all([serveFixture(), serveWellKnown("valid"), serveWellKnown("broken"), serveOrigin("soft")]);
    });

    after(() => Promise.all([site.close(), valid.close(), broken.close(), soft.close()]));

    it("passes every present file on a valid origin", async () => {
        const report = await audit({ seeds: [`${valid.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), []);
        assert.ok(report.summary.checks.total >= 20);
    });

    it("faults every malformed file, the missing change-password and an unregistered suffix", async () => {
        const report = await audit({ seeds: [`${broken.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        const expected = ["agent-card", "agent-skills", "ai-catalog", "api-catalog", "apple-app-site-association", "assetlinks", "change-password", "gpc", "llms-txt-valid", "mcp-server-card", "nodeinfo", "oauth-authorization-server", "oauth-protected-resource", "okf", "openid-configuration", "registered", "schemamap", "security-txt-expires", "security-txt-valid", "tdmrep", "traffic-advice", "webauthn"];
        assert.deepEqual(rules(report), expected.map((id) => `well-known/${id}`));
        const message = (id: string): string => report.findings.find((finding) => finding.rule === `well-known/${id}`)?.message ?? "";
        assert.match(message("security-txt-valid"), /line 2 is not a field.*Contact nope is not a URI/);
        assert.match(message("registered"), /“made-up”/);
        assert.match(message("llms-txt-valid"), /answers 404/);
    });

    it("reports only the absent security.txt and llms.txt where every other file is missing", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], exclude: EXCLUDE, rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["well-known/llms-txt", "well-known/security-txt"]);
    });

    it("takes a soft 404’s HTML for absence, not for malformed files", async () => {
        const report = await audit({ seeds: [`${soft.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["well-known/llms-txt", "well-known/security-txt"]);
    });

    it("probes only the files of the enabled preset", async () => {
        const before = site.requested.length;
        await audit({ seeds: [`${site.origin}/`], exclude: EXCLUDE, rules: ["well-known:security"], cacheMode: "off" });
        const probed = new Set(site.requested.slice(before));
        assert.ok(probed.has("/.well-known/security.txt"));
        assert.ok(!probed.has("/llms.txt"));
    });
});
