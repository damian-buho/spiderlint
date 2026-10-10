// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { spiderlint } from "./fixtures/cli.ts";

describe("cli-errors", () => {
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

    it("exits 3 naming the network error when a seed’s origin is unreachable", async () => {
        // Port 1023 is privileged and not a Fetch bad port, so no parallel test file can be listening on it.
        const run = await spiderlint(directory, "audit", "http://127.0.0.1:1023/", "--no-cache", "--no-sitemap");
        assert.equal(run.code, 3, run.stderr);
        const seed = run.stderr
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { msg: string; error?: string })
            .find((entry) => entry.msg.startsWith("seed not crawled"));
        assert.match(seed?.error ?? "", /ECONNREFUSED/);
    });

    it("exits 2 on a seed that is not an http or https URL, before any request", async () => {
        for (const seed of ["ftp://example.com/", "file:///etc/hosts"]) {
            const run = await spiderlint(directory, "audit", seed, "--no-cache");
            assert.equal(run.code, 2);
            assert.match(run.stderr, /not an http or https URL/);
        }
    });

    it("names the command that aborted", async () => {
        const run = await spiderlint(directory, "explain-rule", "nope/nope");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /"command":"explain-rule".*"msg":"explain-rule aborted"/);
    });

    it("exits 2 naming a flag with an invalid value, without the whole usage", async () => {
        const run = await spiderlint(directory, "audit", "https://example.com/", "--format", "nope");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /--format: invalid value nope \(expected: human\|json\|sarif\|checkstyle\|csv\|html\|agent\)/);
        assert.doesNotMatch(run.stderr, /Usage:/);
    });

    it("exits 2 on --output with a format other than agent", async () => {
        const run = await spiderlint(directory, "audit", "https://example.com/", "--format", "json", "--output", directory);
        assert.equal(run.code, 2);
        assert.match(run.stderr, /--output: writes one file per rule for --format agent only, not json/);
    });

    it("exits 4 when the run itself fails", async () => {
        const file = path.join(directory, "not-a-directory");
        await writeFile(file, "");
        const run = await spiderlint(directory, "crawl", `${site.origin}/`, "--store", path.join(file, "store"));
        assert.equal(run.code, 4);
        assert.match(run.stderr, /"msg":"crawl aborted"/);
    });

    it("refuses a severity override naming no known rule before any request", async () => {
        const before = site.requested.length;
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--max-pages", "1", "--error", "nope/nothing", "--fail-on", "never");
        assert.equal(run.code, 2);
        assert.equal(site.requested.length, before);
        assert.match(run.stderr, /names no known rule: nope\/nothing;/);
    });

    it("suggests the rule glob an --exclude-rules typo meant", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--rules", "all", "--exclude-rules", "lighthuse/*");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /lighthuse\/\* \(did you mean lighthouse\/\*\?\)/);
    });

    it("shows usage for audit with no url, ignoring projectfile links", async () => {
        const project = await mkdtemp(path.join(directory, "linked-"));
        await writeFile(path.join(project, "projectfile.yaml"), ["links:", "  - type: homepage", `    url: ${site.origin}/`].join("\n"));
        const run = await spiderlint(project, "audit");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /usage: spiderlint/i);
    });

    it("rejects an unknown flag in one line, with no stack trace", async () => {
        const run = await spiderlint(directory, "lint", "https://a.test/", "--log-levl", "error");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /^spiderlint: unknown option '--log-levl' \(did you mean --log-level\?\) \(see spiderlint --help\)\n$/);
    });

    it("keeps stderr empty at --log-level silent", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--no-cache", "--log-level", "silent");
        assert.equal(run.stderr, "");
    });

    it("rejects an unknown --log-level", async () => {
        const run = await spiderlint(directory, "lint", "https://a.test/", "--log-level", "loud");
        assert.equal(run.code, 2);
        assert.equal(run.stderr, "spiderlint: --log-level: unknown level loud (see spiderlint --help)\n");
    });
});
