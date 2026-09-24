// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OfflineMiss } from "../src/cache/index.ts";
import { cacheStatus } from "../src/cache/status.ts";
import { audit, crawl, lintStore, reportStore } from "../src/index.ts";
import type { Finding } from "../src/rules/types.ts";
import { DiskStore } from "../src/store/disk.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

// Order-free identity of a finding list.
function keys(findings: Finding[]): string[] {
    return findings.map((finding) => `${finding.rule} ${finding.url} ${finding.message}`).toSorted((a, b) => a.localeCompare(b));
}

describe("store", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-store-"));
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("lints stored facts into the findings a streaming audit reports", async () => {
        const seeds = [`${site.origin}/`];
        const streamed = await audit({ seeds, exclude: ["/tmp/**"] });
        const pages = await crawl({ seeds, exclude: ["/tmp/**"] }, directory);
        assert.equal(pages.length, streamed.pages.length);
        const requests = site.requested.length;
        const linted = await lintStore({}, directory);
        assert.equal(site.requested.length, requests, "lint --store reaches no network");
        assert.deepEqual(keys(linted.findings), keys(streamed.findings));
    });

    it("re-formats the stored report", async () => {
        const report = await reportStore(directory);
        const linted = await lintStore({}, directory);
        assert.deepEqual(keys(report.findings), keys(linted.findings));
        assert.equal(report.summary.pages, linted.summary.pages);
    });

    it("keeps a body per page and no cookie value anywhere", async () => {
        const bodies = await readdir(path.join(directory, "key_value_stores", "bodies"));
        assert.ok(bodies.filter((name) => name.endsWith(".html")).length >= 13);
        const facts = await readdir(path.join(directory, "datasets", "facts"));
        const contents = await Promise.all(facts.map((name) => readFile(path.join(directory, "datasets", "facts", name), "utf8")));
        assert.ok(contents.every((content) => !content.includes("s3cr3t")));
    });

    it("resumes a finished crawl without fetching a page again", async () => {
        const before = site.requested.length;
        const pages = await crawl({ seeds: [`${site.origin}/`], exclude: ["/tmp/**"] }, directory, true);
        const paths = new Set(pages.map((page) => page.url.pathname));
        assert.deepEqual(site.requested.slice(before).filter((request) => paths.has(request)), []);
        assert.equal(pages.length, 15);
    });

    it("refuses a second process on a locked store with exit 2", async () => {
        const store = await DiskStore.open(directory, { fresh: false });
        try {
            const result = spawnSync(process.execPath, ["--experimental-strip-types", CLI, "lint", "--store", directory], { encoding: "utf8" });
            assert.equal(result.status, 2, result.stderr);
            assert.match(result.stderr, /is in use by another process/);
        } finally {
            await store.close(false);
        }
    });

    it("re-crawls a capped audit into a store that already holds one", async () => {
        const again = path.join(directory, "again");
        const options = { seeds: [`${site.origin}/`], maxPages: 2, fetchResources: false };
        await audit(options, { store: again });
        const second = await audit(options, { store: again });
        assert.equal(second.pages.length, 2);
    });

    it("audits offline from the store without a single request", async () => {
        const before = site.requested.length;
        const offline = await audit({ seeds: [`${site.origin}/`], exclude: ["/tmp/**"], cacheMode: "offline" }, { store: directory });
        assert.equal(offline.pages.length, 15);
        assert.equal(site.requested.length, before);
    });

    it("fails an offline audit on an empty store with an offline miss", async () => {
        await assert.rejects(audit({ seeds: [`${site.origin}/`], cacheMode: "offline" }, { store: path.join(directory, "empty") }), OfflineMiss);
    });

    it("measures every bucket present", async () => {
        const buckets = await cacheStatus(directory);
        const pages = buckets.find((bucket) => bucket.bucket === "pages");
        assert.equal(pages?.entries, 15);
        assert.ok((pages?.bytes ?? 0) > 0);
        const absent = await cacheStatus(path.join(directory, "absent"));
        assert.deepEqual(absent.map((bucket) => bucket.bucket).filter((bucket) => bucket !== "robots"), []);
    });
});
