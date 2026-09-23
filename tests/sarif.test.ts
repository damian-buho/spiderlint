// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { audit, type Report } from "../src/index.ts";
import { formatSarif } from "../src/report/sarif.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = {
    posts: { match: ["/posts/**"], rules: ["seo"] },
    tags: { match: ["re:^/tags/[a-z]$"], rules: ["seo"] },
    app: { match: ["/app/**"], rules: ["seo"] },
    default: { rules: ["seo", "links"] },
};

const schema = JSON.parse(readFileSync(new URL("fixtures/sarif-shape.schema.json", import.meta.url), "utf8")) as object;
const validate = new Ajv2020({ strictTypes: false }).compile(schema);

describe("formatSarif", () => {
    let site: Fixture;
    let report: Report;
    let sarif: ReturnType<typeof JSON.parse>;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"] });
        sarif = JSON.parse(formatSarif(report));
    });

    after(() => site.close());

    it("validates against the SARIF 2.1.0 result/location shape", () => {
        const valid = validate(sarif);
        assert.ok(valid, JSON.stringify(validate.errors));
    });

    it("lists one result per finding, driven by the same rule catalog", () => {
        assert.equal(sarif.runs[0].results.length, report.findings.length);
        const ruleIds = new Set(sarif.runs[0].tool.driver.rules.map((rule: { id: string }) => rule.id));
        assert.deepEqual(ruleIds, new Set(report.findings.map((finding) => finding.rule)));
    });

    it("carries occurrenceCount and relatedLocations for a folded finding", () => {
        const folded = report.findings.find((finding) => finding.occurrences !== undefined);
        const result = sarif.runs[0].results.find((entry: { ruleId: string }) => entry.ruleId === folded?.rule);
        assert.equal(result.occurrenceCount, folded?.occurrences);
        assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, folded?.url);
        assert.deepEqual(
            result.relatedLocations.map((location: { physicalLocation: { artifactLocation: { uri: string } } }) => location.physicalLocation.artifactLocation.uri),
            folded?.samples?.filter((url) => url !== folded.url),
        );
    });

    it("carries relatedLocations for a site-wide finding sharing a value across pages", () => {
        const shared = report.findings.find((finding) => finding.scope === "site" && (finding.urls?.length ?? 0) > 1);
        const result = sarif.runs[0].results.find((entry: { ruleId: string }) => entry.ruleId === shared?.rule);
        assert.deepEqual(
            result.relatedLocations.map((location: { physicalLocation: { artifactLocation: { uri: string } } }) => location.physicalLocation.artifactLocation.uri).toSorted((a: string, b: string) => a.localeCompare(b)),
            shared?.urls?.filter((url) => url !== shared.url).toSorted((a, b) => a.localeCompare(b)),
        );
    });

    it("embeds the run summary as the invocation", () => {
        const [invocation] = sarif.runs[0].invocations;
        assert.equal(invocation.executionSuccessful, true);
        assert.equal(invocation.startTimeUtc, report.summary.started);
        assert.equal(Date.parse(invocation.endTimeUtc) - Date.parse(invocation.startTimeUtc), report.summary.durationMs);
        assert.deepEqual(invocation.properties.statuses, { "200": 14, "404": 1 });
        assert.equal(invocation.properties.pages, 15);
    });

    it("maps severity to the SARIF level vocabulary", () => {
        const info = report.findings.find((finding) => finding.severity === "info");
        const result = sarif.runs[0].results.find((entry: { ruleId: string; locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) => entry.ruleId === info?.rule && entry.locations[0]?.physicalLocation.artifactLocation.uri === info?.url);
        assert.equal(result.level, "note");
    });
});
