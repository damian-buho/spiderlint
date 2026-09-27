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
        const streamed = await audit({ seeds, excludeUrls: ["/tmp/**"] });
        const pages = await crawl({ seeds, excludeUrls: ["/tmp/**"] }, directory);
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

    it("measures a run against the last one that ran all its rules over the same crawl", async () => {
        const first = await lintStore({}, directory);
        const again = await lintStore({}, directory);
        assert.deepEqual(again.summary.previous, { started: first.summary.started, findings: first.summary.findings });
        const narrower = await lintStore({ rules: ["tls"], excludeRules: ["tls/cert-expiry"] }, directory);
        assert.deepEqual(narrower.summary.previous?.findings, narrower.summary.findings, "a subset reads the wider run’s counts for its own rules");
        const wider = await lintStore({}, directory);
        assert.equal(wider.summary.previous, undefined, "the last run did not run every rule");
        const last = await lintStore({ rules: ["tls"] }, directory);
        const seeds = [`${site.origin}/`];
        const audited = await audit({ seeds, excludeUrls: ["/tmp/**"], rules: ["tls"] }, { store: directory });
        assert.equal(audited.summary.previous?.started, last.summary.started);
        const scoped = await mkdtemp(path.join(tmpdir(), "spiderlint-scope-"));
        await audit({ seeds, excludeUrls: ["/tmp/**"], rules: ["tls"] }, { store: scoped });
        const fewerPages = await audit({ seeds, excludeUrls: ["/tmp/**"], rules: ["tls"], maxPages: 1 }, { store: scoped });
        await rm(scoped, { recursive: true, force: true });
        assert.equal(fewerPages.summary.previous, undefined, "a crawl of another scope is no baseline");
    });

    it("keeps a body per page and no cookie value anywhere", async () => {
        const bodies = await readdir(path.join(directory, "key_value_stores", "bodies"));
        assert.ok(bodies.filter((name) => name.endsWith(".txt")).length >= 13);
        const facts = await readdir(path.join(directory, "datasets", "facts"));
        const contents = await Promise.all(facts.map((name) => readFile(path.join(directory, "datasets", "facts", name), "utf8")));
        assert.ok(contents.every((content) => !content.includes("s3cr3t")));
    });

    it("resumes a finished crawl without fetching a page again", async () => {
        const before = site.requested.length;
        const pages = await crawl({ seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"] }, directory, true);
        const paths = new Set(pages.map((page) => page.url.pathname));
        assert.deepEqual(site.requested.slice(before).filter((request) => paths.has(request)), []);
        assert.equal(pages.length, 16);
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

    it("revalidates a re-crawl and keeps the content facts of every 304", async () => {
        const again = path.join(directory, "revalidate");
        const options = { seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"], fetchResources: false };
        const first = await audit(options, { store: again });
        const second = await audit(options, { store: again });
        const revalidated = second.pages.filter((page) => page.http.revalidated);
        assert.ok(revalidated.length > 10, `${revalidated.length} pages revalidated`);
        assert.equal(second.pages.length, first.pages.length);
        assert.deepEqual(keys(second.findings), keys(first.findings));
        for (const page of revalidated) assert.deepEqual(page.html, first.pages.find((earlier) => earlier.url.href === page.url.href)?.html);
        const refreshed = await audit({ ...options, cacheMode: "refresh" }, { store: again });
        assert.equal(refreshed.pages.filter((page) => page.http.revalidated).length, 0);
    });

    it("replays a revalidated JSON page with the body it stored", async () => {
        const again = path.join(directory, "json");
        const options = { seeds: [`${site.origin}/data.json`], sitemap: false, fetchResources: false };
        const first = await audit(options, { store: again });
        const second = await audit(options, { store: again });
        const [page] = second.pages;
        assert.equal(page?.http.revalidated, true);
        assert.equal(page.http["content-type"], "application/json");
        assert.deepEqual(page.http.size, first.pages[0]?.http.size);
        const store = await DiskStore.open(again, { fresh: false });
        try {
            assert.equal(await store.body(page.url.href), '{"name": "fixture"}');
        } finally {
            await store.close(false);
        }
    });

    it("remembers a failing resource and reports it again from the cache", async () => {
        const again = path.join(directory, "failed");
        const options = { seeds: [`${site.origin}/down-page`], sitemap: false, rules: ["resources"], fold: false as const };
        const asked = () => site.requested.filter((pathname) => pathname === "/down.png").length;
        const statuses = (report: Awaited<ReturnType<typeof audit>>) => report.findings.filter((finding) => finding.rule === "resources/status").map((finding) => finding.message);
        const first = await audit(options, { store: again });
        const before = asked();
        const second = await audit(options, { store: again });
        assert.equal(asked(), before, "a fresh failure is not asked again");
        assert.match(statuses(first)[0] ?? "", /answers 503/);
        assert.deepEqual(statuses(second), statuses(first));
        assert.equal(second.pages[0]?.resources?.[0]?.http?.cached, true);
        assert.equal(second.summary.cost.resources?.failuresCached, 1);
        await audit({ ...options, cacheMode: "refresh" }, { store: again });
        assert.ok(asked() > before, "--refresh asks again");
    });

    it("answers an unchanged page from the extractors bucket instead of analysing it again", async () => {
        const again = path.join(directory, "extractors");
        const options = { seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"], fetchResources: false, rules: ["html-validate", "htmlhint"] };
        const first = await audit(options, { store: again });
        const second = await audit(options, { store: again });
        assert.ok((first.summary.cost.extractors.htmlvalidate ?? 0) > 10);
        assert.deepEqual(second.summary.cost.extractors, {});
        const served = (cost: typeof first.summary.cost, id: string) => (cost.extractors[id] ?? 0) + (cost.extractorsCached?.[id] ?? 0);
        for (const id of ["htmlvalidate", "htmlhint"]) assert.equal(second.summary.cost.extractorsCached?.[id], served(first.summary.cost, id), id);
        assert.deepEqual(keys(second.findings), keys(first.findings));
        const buckets = await cacheStatus(again);
        assert.ok((buckets.find((bucket) => bucket.bucket === "extractors")?.entries ?? 0) > 20);
    });

    it("audits offline from the store without a single request", async () => {
        const before = site.requested.length;
        const offline = await audit({ seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"], cacheMode: "offline" }, { store: directory });
        assert.equal(offline.pages.length, 16);
        assert.equal(site.requested.length, before);
    });

    it("fails an offline audit on an empty store with an offline miss", async () => {
        await assert.rejects(audit({ seeds: [`${site.origin}/`], cacheMode: "offline" }, { store: path.join(directory, "empty") }), OfflineMiss);
    });

    it("measures every bucket present", async () => {
        const buckets = await cacheStatus(directory);
        const pages = buckets.find((bucket) => bucket.bucket === "pages");
        assert.equal(pages?.entries, 16);
        assert.ok((pages?.bytes ?? 0) > 0);
        const absent = await cacheStatus(path.join(directory, "absent"));
        assert.deepEqual(absent.map((bucket) => bucket.bucket).filter((bucket) => !["robots", "probes"].includes(bucket)), []);
    });
});
