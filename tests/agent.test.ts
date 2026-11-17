// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, type Report } from "../src/index.ts";
import { agentFiles, formatAgent, writeAgentFiles } from "../src/report/agent.ts";
import { formatHtml } from "../src/report/html.ts";
import { formatHuman } from "../src/report/human.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = { posts: { match: ["/posts/**"], rules: ["seo"] }, default: { rules: ["seo", "links"] } };
const SNAPSHOT = new URL("fixtures/agent.snap", import.meta.url);
// The snapshot’s licence header, kept out of the comparison.
const HEADER = /^(?:# SPDX.*\n|#\n)+\n/;

const make = (name: string, text: string, urls: string[]) => ({ rule: "images/format/outdated", severity: "warning" as const, scope: "site" as const, url: `https://cdn.test/${name}`, message: text, text, urls });

describe("agent format", () => {
    let site: Fixture;
    let report: Report;
    let output: string;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
        output = `${formatAgent({ ...report, summary: { ...report.summary, stats: undefined } })
            .replaceAll(site.origin, "ORIGIN")
            .replaceAll(/http:\/\/localhost:\d+/g, "EXTERNAL")
            .replaceAll(/checked \d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "checked TIME")}\n`;
    });
    after(() => site.close());

    it("matches the fixture snapshot", async () => {
        const saved = await readFile(SNAPSHOT, "utf8");
        const header = HEADER.exec(saved)?.[0] ?? "";
        if (process.env.SPIDERLINT_UPDATE_SNAPSHOTS) await writeFile(SNAPSHOT, `${header}${output}`);
        assert.equal(output, saved.slice(header.length));
    });

    it("folds html/h1/missing into one block naming its samples and lists links/internal/unreachable referrers", () => {
        const blocks = output.split(/^## /m).slice(1);
        const oneH1 = blocks.filter((block) => block.startsWith("html/h1/missing "));
        assert.equal(oneH1.length, 1);
        assert.match(oneH1[0] as string, /5 pages of group posts[^\n]*\n- \/posts\/1: none\n- \/posts\/2: none\n- \/posts\/3: none\n/);
        assert.match(blocks.find((block) => block.startsWith("links/internal/unreachable ")) ?? "", /Where: \/missing, used by or shared with:\n- \/\n- \/about\n/);
        for (const block of blocks) {
            assert.match(block, /^Fix: /m, block);
            assert.match(block, /^Done when: `spiderlint audit ORIGIN\/ --rules [^`]+` reports no /m, block);
        }
    });

    it("merges resource findings sharing a message into one block, and keeps a different message apart", () => {
        const findings = [make("a.jpg", "a jpeg image is smaller as avif", ["/x", "/y"]), make("b.jpg", "a jpeg image is smaller as avif", ["/x"]), make("c.png", "a png image is smaller as webp", ["/z"])];
        const blocks = formatAgent({ ...report, findings, rules: undefined })
            .split(/^## /m)
            .slice(1);
        assert.equal(blocks.length, 2);
        const merged = blocks.find((block) => block.includes("as avif")) ?? "";
        assert.match(merged, /Where: 2 findings:\n- https:\/\/cdn\.test\/a\.jpg\n {2}used by or shared with:\n {2}- \/x\n {2}- \/y\n- https:\/\/cdn\.test\/b\.jpg\n {2}used by or shared with:\n {2}- \/x\n/);
        assert.match(blocks.find((block) => block.includes("as webp")) ?? "", /Where: https:\/\/cdn\.test\/c\.png, used by or shared with:\n- \/z\n/);
    });

    it("merges the same findings once in the human and html reports, a shared page list printed once", () => {
        const findings = [make("a.jpg", "a jpeg image is smaller as avif", [`${site.origin}/x`, `${site.origin}/y`]), make("b.jpg", "a jpeg image is smaller as avif", [`${site.origin}/x`, `${site.origin}/y`])];
        const input = { ...report, findings, rules: undefined };
        const human = formatHuman(input, undefined, false, "en");
        assert.equal(human.match(/images\/format\/outdated — 2 findings/g)?.length, 1);
        assert.equal(human.match(/^ {12}\/x$/gm)?.length, 1, human);
        const html = formatHtml(input, undefined, false, "en");
        assert.equal(html.match(/a jpeg image is smaller as avif/g)?.length, 1);
        assert.equal(html.match(/>\/x<\/a>/g)?.length, 1);
    });

    it("ends with the CO2, bytes, requests and timings of the crawl, timings varying run to run", () => {
        const table = formatAgent(report).split("\n\n# Site statistics\n\n", 2)[1] ?? "";
        const paths = table
            .matchAll(/^\| `([^`]+)`/gm)
            .map((match) => match[1])
            .toArray();
        assert.deepEqual(paths.slice(0, 2), ["co2.bytes", "co2.grams"]);
        assert.ok(paths.includes("resources.length") && paths.includes("http.timing.total"), table);
        assert.ok(!paths.includes("graph.rank"), table);
    });

    it("puts the most important rule first, the score beside its level", () => {
        assert.match(output, /^# spiderlint findings for ORIGIN\n\n# Summary\n\n- Rating: \S+ \([^)]+\)\n- Pages: \d+\n- Findings: \d+ \([^)]+\)\n- Checks passed: [^\n]+\n\n## links\/internal\/unreachable \(error 7\.4\)/);
    });

    it("writes one file per rule and rewrites the same bytes", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "spiderlint-agent-"));
        try {
            await writeAgentFiles(directory, report);
            const first = await readFile(path.join(directory, "html-h1-missing.md"), "utf8");
            await writeAgentFiles(directory, report);
            const written = await readdir(directory);
            assert.deepEqual(
                written.toSorted((a, b) => a.localeCompare(b)),
                agentFiles(report)
                    .keys()
                    .toArray()
                    .toSorted((a, b) => a.localeCompare(b)),
            );
            assert.equal(await readFile(path.join(directory, "html-h1-missing.md"), "utf8"), first);
            assert.match(first, /^# spiderlint: html\/h1\/missing on http:\/\/127\.0\.0\.1:\d+\n\n## html\/h1\/missing \(error 7\.4\)\n/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
