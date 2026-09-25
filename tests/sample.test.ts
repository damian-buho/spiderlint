// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, crawl, lintStore, loadPlugins, type Report } from "../src/index.ts";
import { formatHuman } from "../src/report/human.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const EXCLUDE = ["/tmp/**"];
const GROUPS = { posts: { match: ["/posts/**"], rules: ["heavy"], sample: 2 }, default: { rules: [], sample: "all" as const } };

describe("sample", () => {
    let site: Fixture;
    let directory: string;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-sample-"));
        await loadPlugins(["./tests/fixtures/sample-plugin.ts"]);
        report = await audit({ seeds: [`${site.origin}/`], exclude: EXCLUDE, groups: GROUPS, fold: { threshold: 0.8, min: 2 }, cacheMode: "off" });
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    const posts = (pages: Report["pages"]) => pages.filter((page) => page.group === "posts");

    it("runs an expensive extractor on the group’s sample and a cheap one on every page", () => {
        assert.equal(posts(report.pages).length, 5);
        assert.equal(posts(report.pages).filter((page) => page.heavy !== undefined).length, 2);
        assert.equal(posts(report.pages).filter((page) => page.length !== undefined).length, 5);
    });

    it("runs it on every page of a group sampling all", () => {
        const html = report.pages.filter((page) => page.group === "default" && page.html);
        assert.ok(html.length > 3);
        assert.ok(html.every((page) => page.heavy !== undefined));
    });

    it("folds a sampled rule as failing on its sampled pages", () => {
        const [folded, ...rest] = report.findings.filter((finding) => finding.rule === "heavy/ran");
        assert.equal(rest.length, 0);
        assert.equal(folded?.occurrences, 2);
        assert.equal(folded?.sampled, 2);
        assert.match(formatHuman(report), /heavy\/ran — 2 of 2 sampled pages \(100%\): heavy ran/);
    });

    it("backfills a stored crawl on the lowest URLs of each group", async () => {
        const store = path.join(directory, "store");
        await crawl({ seeds: [`${site.origin}/`], exclude: EXCLUDE, rules: ["seo"] }, store);
        const linted = await lintStore({ groups: GROUPS }, store);
        const sampled = posts(linted.pages).filter((page) => page.heavy !== undefined).map((page) => page.url.pathname);
        assert.deepEqual(sampled.toSorted((a, b) => a.localeCompare(b)), ["/posts/1", "/posts/2"]);
    });
});
