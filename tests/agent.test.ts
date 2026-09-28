// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, type Report } from "../src/index.ts";
import { agentFiles, formatAgent, writeAgentFiles } from "../src/report/agent.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = { posts: { match: ["/posts/**"], rules: ["seo"] }, default: { rules: ["seo", "links"] } };
const SNAPSHOT = new URL("fixtures/agent.snap", import.meta.url);
// The snapshot’s licence header, kept out of the comparison.
const HEADER = /^(?:# SPDX.*\n|#\n)+\n/;

describe("agent format", () => {
    let site: Fixture;
    let report: Report;
    let output: string;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
        output = `${formatAgent({ ...report, summary: { ...report.summary, stats: undefined } }).replaceAll(site.origin, "ORIGIN").replaceAll(/http:\/\/localhost:\d+/g, "EXTERNAL")}\n`;
    });
    after(() => site.close());

    it("matches the fixture snapshot", async () => {
        const saved = await readFile(SNAPSHOT, "utf8");
        const header = HEADER.exec(saved)?.[0] ?? "";
        if (process.env.SPIDERLINT_UPDATE_SNAPSHOTS) await writeFile(SNAPSHOT, `${header}${output}`);
        assert.equal(output, saved.slice(header.length));
    });

    it("folds html/one-h1 into one block naming its samples and lists links/broken-internal referrers", () => {
        const blocks = output.split(/^## /m).slice(1);
        const oneH1 = blocks.filter((block) => block.startsWith("html/one-h1 "));
        assert.equal(oneH1.length, 1);
        assert.match(oneH1[0] as string, /5 pages of group posts[^\n]*\n- \/posts\/1\n- \/posts\/2\n- \/posts\/3\n/);
        assert.match(blocks.find((block) => block.startsWith("links/broken-internal ")) ?? "", /Where: \/missing, used by or shared with:\n- \/\n- \/about\n/);
        for (const block of blocks) {
            assert.match(block, /^Fix: /m, block);
            assert.match(block, /^Done when: `spiderlint audit ORIGIN\/ --rules [^`]+` reports no /m, block);
        }
    });

    it("ends with the CO2, bytes, requests and timings of the crawl, timings varying run to run", () => {
        const table = formatAgent(report).split("\n\n# Site statistics\n\n", 2)[1] ?? "";
        const paths = table.matchAll(/^\| `([^`]+)`/gm).map((match) => match[1]).toArray();
        assert.deepEqual(paths.slice(0, 2), ["co2.bytes", "co2.grams"]);
        assert.ok(paths.includes("resources.length") && paths.includes("http.timing.total"), table);
        assert.ok(!paths.includes("graph.rank"), table);
    });

    it("orders errors first, then the rule clearing the most pages", () => {
        const rules = output.matchAll(/^## (\S+) \((\w+)\)/gm).map((match) => match[2]).toArray();
        assert.deepEqual(rules, rules.toSorted((a, b) => ["error", "warning", "info"].indexOf(a ?? "") - ["error", "warning", "info"].indexOf(b ?? "")));
        assert.match(output, /^# spiderlint findings for ORIGIN\n\n## links\/broken-internal \(error\)/);
    });

    it("writes one file per rule and rewrites the same bytes", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "spiderlint-agent-"));
        try {
            await writeAgentFiles(directory, report);
            const first = await readFile(path.join(directory, "html-one-h1.md"), "utf8");
            await writeAgentFiles(directory, report);
            const written = await readdir(directory);
            assert.deepEqual(written.toSorted((a, b) => a.localeCompare(b)), agentFiles(report).keys().toArray().toSorted((a, b) => a.localeCompare(b)));
            assert.equal(await readFile(path.join(directory, "html-one-h1.md"), "utf8"), first);
            assert.match(first, /^# spiderlint: html\/one-h1 on http:\/\/127\.0\.0\.1:\d+\n\n## html\/one-h1 \(error\)\n/);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
