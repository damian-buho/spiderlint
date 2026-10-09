// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { audit, lintStore, reportStore, type Report } from "../src/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

// The sitemap rule that judges the whole site, as a report shows it.
function orphans(report: Report): string[] {
    return report.findings.filter((finding) => finding.rule === "sitemap/orphan").map((finding) => new URL(finding.url).pathname);
}

describe("crawl complete", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-complete-"));
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("reports a true orphan when the crawl ran to the end", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["sitemap"], cacheMode: "off", fetchResources: false });
        assert.deepEqual(report.site.crawl, { complete: true });
        assert.deepEqual(orphans(report), ["/orphan"]);
    });

    it("skips the orphan rule, untested, when the page budget ended the crawl", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["sitemap"], cacheMode: "off", fetchResources: false, maxPages: 2 });
        assert.deepEqual(report.site.crawl, { complete: false, reason: "max-pages" });
        assert.deepEqual(orphans(report), []);
        assert.ok(report.summary.untested?.includes("sitemap/orphan"));
        assert.equal(report.summary.checked?.["sitemap/orphan"], undefined);
    });

    it("names the depth limit when it cut a link", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["sitemap"], cacheMode: "off", fetchResources: false, maxDepth: 1 });
        assert.deepEqual(report.site.crawl, { complete: false, reason: "max-depth" });
        assert.deepEqual(orphans(report), []);
    });

    it("keeps the interrupted reason in the store, and lint reads it back", async () => {
        const stopped = path.join(directory, "stopped");
        const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "audit", `${site.origin}/`, "--store", stopped, "--rules", "sitemap", "--no-progress", "--log-level", "info"], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            if (!stderr.includes("page done") && (stderr + chunk).includes("page done")) child.kill("SIGINT");
            stderr += chunk;
        });
        const [code] = (await once(child, "exit")) as [number];
        assert.equal(code, 130, stderr);
        const report = await lintStore({ rules: ["sitemap"] }, stopped);
        assert.deepEqual(report.site.crawl, { complete: false, reason: "interrupted" });
        assert.deepEqual(orphans(report), []);
        assert.ok(report.summary.untested?.includes("sitemap/orphan"));
        const stored = await reportStore(stopped);
        assert.deepEqual(stored.site.crawl, { complete: false, reason: "interrupted" });
    });

    it("returns the pages it has, marked timeout, when the crawl deadline passes", async () => {
        // A chain of pages, each answering after 300 ms, so one crawler never reaches the end in one second.
        const slow = createServer((request, response) => {
            const next = Number(/\d+/.exec(request.url ?? "")?.[0] ?? 0) + 1;
            setTimeout(() => response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>p</title><a href="/p${next}">next</a>`), 300);
        }).listen(0, "127.0.0.1");
        await once(slow, "listening");
        try {
            const origin = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
            const report = await audit({ seeds: [`${origin}/p0`], rules: ["sitemap"], cacheMode: "off", fetchResources: false, concurrency: 1, crawlDeadline: 1, allowPrivate: true });
            assert.deepEqual(report.site.crawl, { complete: false, reason: "timeout" });
            assert.ok(report.pages.length > 0 && report.pages.length < 10, String(report.pages.length));
            assert.ok(report.summary.untested?.includes("sitemap/orphan"));
        } finally {
            slow.closeAllConnections();
            slow.close();
        }
    });

    it("marks the graph findings of a cut crawl as partial", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["graph"], cacheMode: "off", maxPages: 3 });
        assert.deepEqual(report.site.crawl, { complete: false, reason: "max-pages" });
        assert.ok(report.findings.every((finding) => finding.message.includes("ended early (max-pages)")));
    });
});
