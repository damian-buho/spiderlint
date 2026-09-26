// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, crawl, lintStore, loadPlugins, type Report } from "../src/index.ts";
import { PrivateAddress } from "../src/crawl/guard.ts";
import { probe } from "../src/crawl/probe.ts";
import { serveOrigin, type Origin } from "./fixtures/origin.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { runs } from "./fixtures/site-plugin.ts";

const EXCLUDE = ["/tmp/**"];

// Rule IDs of a report’s findings, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("origin preset", () => {
    let site: Fixture;
    let soft: Origin;
    let trace: Origin;

    before(async () => {
        [site, soft, trace] = await Promise.all([serveFixture(), serveOrigin("soft"), serveOrigin("trace")]);
    });

    after(() => Promise.all([site.close(), soft.close(), trace.close()]));

    it("probes the fixture origin once and faults only its plain http entry", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["origin/https-entry"]);
        assert.equal(report.findings[0]?.url, site.origin);
        assert.equal(site.requested.filter((pathname) => pathname.startsWith("/spiderlint-")).length, 1);
        assert.deepEqual(report.summary.cost.extractors, { encodings: 1, entry: 1, favicon: 1, locale: 1, notFound: 1 });
    });

    it("finds a soft 404, a language redirect, gzip alone and a favicon that is a page", async () => {
        const report = await audit({ seeds: [`${soft.origin}/`], rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["origin/compression", "origin/favicon", "origin/https-entry", "origin/locale-redirect", "origin/soft-404"]);
        assert.match(report.findings.find((finding) => finding.rule === "origin/compression")?.message ?? "", /gzip/);
        assert.match(report.findings.find((finding) => finding.rule === "origin/soft-404")?.message ?? "", /answers 200/);
    });

    it("finds a stack trace on the not-found page and accepts a one-hop https entry", async () => {
        const report = await audit({ seeds: [`${trace.origin}/page`], rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["origin/error-page", "origin/favicon"]);
    });

    it("probes nothing when no enabled rule reads site.origins", async () => {
        const before = site.requested.length;
        await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"], cacheMode: "off" });
        assert.ok(site.requested.slice(before).every((pathname) => !pathname.startsWith("/spiderlint-") && pathname !== "/favicon.ico"));
    });
});

describe("site extractor plugins", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-sites-"));
        await loadPlugins(["./tests/fixtures/site-plugin.ts"]);
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("runs a per-host extractor once, keys its facts by host, and gives up on one past its timeout", async () => {
        const store = path.join(directory, "store");
        const started = Date.now();
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"] }, { store });
        assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.url, finding.value]), [["hosts/robots-gone", "127.0.0.1", 200]]);
        assert.deepEqual(runs, { robots: 1, stuck: 1 });
        assert.ok(Date.now() - started < 10_000, "the stuck extractor is abandoned at its timeout");
    });

    it("answers a re-crawl from the origins bucket and an offline audit from the store", async () => {
        const store = path.join(directory, "store");
        const again = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"] }, { store });
        const offline = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"], cacheMode: "offline" }, { store });
        assert.deepEqual(runs, { robots: 1, stuck: 2 });
        assert.deepEqual(rules(again), ["hosts/robots-gone"]);
        assert.deepEqual(rules(offline), ["hosts/robots-gone"]);
    });

    it("skips its rules on a store crawled without them, probing nothing", async () => {
        const store = path.join(directory, "plain");
        await crawl({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"] }, store);
        const linted = await lintStore({ rules: ["hosts"] }, store);
        assert.deepEqual(linted.findings, []);
        assert.equal(linted.summary.checks.total, 0);
        assert.deepEqual(runs, { robots: 1, stuck: 2 });
    });
});

describe("probe", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(() => site.close());

    it("refuses a private address unless allowed, and any URL off its host", async () => {
        const signal = new AbortController().signal;
        await assert.rejects(probe(`${site.origin}/`, {}, { host: "127.0.0.1", allowPrivate: false, signal }), PrivateAddress);
        await assert.rejects(probe("http://localhost/", {}, { host: "127.0.0.1", allowPrivate: true, signal }), /leaves host/);
        const answer = await probe(`${site.origin}/old-about`, { redirect: "follow" }, { host: "127.0.0.1", allowPrivate: true, signal });
        assert.deepEqual([answer.status, answer.redirects.map((hop) => hop.status)], [200, [301]]);
    });
});
