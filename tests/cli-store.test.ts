// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./fixtures/csv.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { spiderlint, parsed } from "./fixtures/cli.ts";

describe("cli-store", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-cli-"));
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("formats with a plugin formatter and seeds from a plugin source, which follows links", async () => {
        const project = await mkdtemp(path.join(directory, "output-"));
        const plugin = fileURLToPath(new URL("fixtures/output-plugin.ts", import.meta.url));
        await writeFile(path.join(project, "spiderlint.yaml"), ["org:", "  spiderlint:", `    plugins: [${plugin}]`, `    sources: ["pair:${site.origin}"]`].join("\n"));
        const run = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--format", "paths", "--no-cache", "--no-sitemap", "--fail-on", "never");
        assert.equal(run.code, 0, run.stderr);
        const paths = run.stdout.trim().split("\n");
        assert.ok(paths.includes("/about") && paths.includes("/orphan") && paths.length > 2, run.stdout);
    });

    it("crawls a list:FILE source as the whole frontier, and refuses an unknown source", async () => {
        const project = await mkdtemp(path.join(directory, "list-"));
        const plugin = fileURLToPath(new URL("fixtures/output-plugin.ts", import.meta.url));
        await writeFile(path.join(project, "spiderlint.yaml"), ["org:", "  spiderlint:", `    plugins: [${plugin}]`].join("\n"));
        await writeFile(path.join(project, "urls.txt"), ["# two pages", `${site.origin}/about`, "", `${site.origin}/orphan`].join("\n"));
        const run = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--source", "list:urls.txt", "--format", "paths", "--no-cache", "--fail-on", "never");
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stdout, "/about\n/orphan\n");
        const unknown = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--source", "nope:x", "--no-cache");
        assert.equal(unknown.code, 2);
        assert.match(unknown.stderr, /source nope: unknown \(known: list, pair\)/);
    });

    it("exits 3 on lint, show-report and export-facts of a site never crawled, creating no store", async () => {
        for (const command of [["lint"], ["show-report"], ["export-facts"]]) {
            const run = await spiderlint(directory, ...command, "https://never-crawled.example/");
            assert.equal(run.code, 3);
            assert.match(run.stderr, /nothing stored in .*run spiderlint audit or crawl first/);
        }
        await assert.rejects(stat(path.join(directory, "cache", "spiderlint", "never-crawled.example")), { code: "ENOENT" });
    });

    it("keeps each site’s store in the user cache, owner-only, so lint needs only the url", async () => {
        const seed = `${site.origin}/`;
        const audited = await spiderlint(directory, "audit", seed, "--max-pages", "2", "--fail-on", "never");
        assert.equal(audited.code, 0);
        const store = path.join(directory, "cache", "spiderlint", new URL(seed).host);
        const { mode } = await stat(store);
        assert.equal(mode & 0o777, 0o700);
        const linted = await spiderlint(directory, "lint", seed, "--format", "json", "--fail-on", "never");
        assert.equal(linted.code, 0);
        assert.equal((parsed(linted) as { summary: { pages: number } }).summary.pages, 2);
        const unnamed = await spiderlint(directory, "lint");
        assert.equal(unnamed.code, 2);
    });

    it("exports every stored page’s facts as CSV, and the json report carries their statistics", async () => {
        const seed = `${site.origin}/`;
        const audited = await spiderlint(directory, "audit", seed, "--rules", "sustainability", "--exclude-urls", "/tmp/**", "--format", "json", "--fail-on", "never");
        assert.equal(audited.code, 0, audited.stderr);
        const { summary } = parsed(audited) as { summary: { pages: number; stats: Record<string, { median: number; total: number }> } };
        assert.ok((summary.stats["co2.grams"]?.total ?? 0) > 0 && (summary.stats["co2.grams"]?.median ?? 0) > 0, JSON.stringify(summary.stats["co2.grams"]));
        assert.equal(Object.keys(summary.stats)[0], "co2.bytes");
        const exported = await spiderlint(directory, "export-facts", seed, "--format", "csv");
        assert.equal(exported.code, 0, exported.stderr);
        const [header = [], ...rows] = parseCsv(exported.stdout.trimEnd());
        assert.equal(rows.length, summary.pages);
        assert.deepEqual(header.slice(0, 3), ["url.href", "group", "co2.bytes"]);
        assert.ok(rows.every((row) => row.length === header.length && row[0]?.startsWith(site.origin)));
        const picked = await spiderlint(directory, "export-facts", seed, "--format", "csv", "--facts", "co2.grams", "--facts", "http.timing.*");
        const [columns = []] = parseCsv(picked.stdout.trimEnd());
        assert.deepEqual(columns.slice(0, 4), ["url.href", "group", "co2.grams", "http.timing.dns"]);
        assert.ok(columns.includes("http.timing.total") && columns.slice(3).every((column) => column.startsWith("http.timing.")), columns.join(","));
        const yaml = await spiderlint(directory, "export-facts", seed, "--format", "yaml");
        assert.match(yaml.stdout, /^pages:\n {2}- url:\n/);
        const refused = await spiderlint(directory, "export-facts", seed, "--format", "json", "--facts", "co2.*");
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /--facts: picks human and csv columns only/);
        const table = await spiderlint(directory, "export-facts", seed);
        assert.equal(table.code, 0, table.stderr);
        assert.match(table.stdout, new RegExp(String.raw`^${site.origin}\nPage +Group +Status +CO₂e per view +Page size +Resources +Total time\n/ +default +200 +[\d.,]+ g +[\d.,]+ (?:k?B|byte) +\d+ +[\d.,]+ ms\n`));
        assert.match(table.stdout, /\nstats +pages +min +median +p95 +max +total\nCO₂e per view +\d+ +[\d.,]+ g /);
        const one = await spiderlint(directory, "show-facts", `${seed}about`);
        assert.equal(one.code, 0, one.stderr);
        assert.match(one.stdout, /^url\.href +http:\/\/127\.0\.0\.1:\d+\/about\n/);
        assert.match(one.stdout, /\nStatus +200\n/);
        const csv = await spiderlint(directory, "export-facts", seed, "--format", "csv", "--facts", "http.timing.total");
        assert.match(csv.stdout, /^url\.href,group,http\.timing\.total\r\n.+,default,\d+(?:\.\d+)?\r\n/);
    });

    it("audits every declared site into its own store, or the ones --site names", async () => {
        const project = await mkdtemp(path.join(directory, "sites-"));
        const other = site.origin.replace("127.0.0.1", "localhost");
        const document = ["org:", "  spiderlint:", "    max-pages: 1", "    sites:", "      static:", `        targets: [${site.origin}/]`, "      preview:", `        targets: [${other}/]`, "        max-pages: 2"].join("\n");
        await writeFile(path.join(project, "projectfile.yaml"), document);
        const stores = path.join(project, "cache", "spiderlint");
        const all = await spiderlint(project, "audit", "--config", "projectfile.yaml", "--fail-on", "never");
        assert.equal(all.code, 0, all.stderr);
        assert.match(all.stdout, /^static$/m);
        assert.match(all.stdout, /^preview$/m);
        await stat(path.join(stores, new URL(site.origin).host));
        await stat(path.join(stores, new URL(other).host));
        const one = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--site", "preview", "--format", "json", "--fail-on", "never");
        assert.equal(one.code, 0, one.stderr);
        assert.equal((parsed(one) as { summary: { pages: number } }).summary.pages, 2);
        const unknown = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--site", "nope");
        assert.equal(unknown.code, 2);
        assert.match(unknown.stderr, /unknown site nope \(declared: (static, preview|preview, static)\)/);
        const machine = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--format", "json");
        assert.equal(machine.code, 2);
    });
});
