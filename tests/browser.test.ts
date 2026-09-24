// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { audit, type Report } from "../src/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

// The node tool image carries no Chromium; the spiderlint image does, and its self-test runs these.
async function launchFailure(): Promise<string | false> {
    try {
        const browser = await chromium.launch();
        await browser.close();
        return false;
    } catch (error) {
        return `Chromium does not launch: ${String(error).split("\n", 1)[0]}`;
    }
}

const skip = await launchFailure();

describe("fetch mode", () => {
    it("refuses a browser rule under an http pin, naming it", async () => {
        await assert.rejects(audit({ seeds: ["http://127.0.0.1:9/"], fetch: "http", groups: { default: { rules: ["browser"] } } }), (error: Error) => error instanceof ConfigError && error.message.includes("rule browser/console-errors in group default"));
    });

    it("stays on http when no rule reads a browser fact", async () => {
        const site = await serveFixture();
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false });
        await site.close();
        assert.equal(report.pages[0]?.browser, undefined);
        assert.equal(report.pages[0]?.http.version, "1.1", "only the http crawler reports the protocol version");
    });

    it("refuses adaptive until it exists", async () => {
        await assert.rejects(audit({ seeds: ["http://127.0.0.1:9/"], fetch: "adaptive" }), ConfigError);
    });
});

describe("browser fetch", { skip }, () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["seo", "browser"] } }, exclude: ["/tmp/**"] });
    });

    after(() => site.close());

    const page = (pathname: string) => report.pages.find((entry) => entry.url.pathname === pathname);

    it("renders when a rule reads a browser fact, crawling what http mode crawls", () => {
        const paths = report.pages.map((entry) => entry.url.pathname).toSorted((a, b) => a.localeCompare(b));
        assert.deepEqual(paths, ["/", "/about", "/app/", "/duplicate", "/feed.xml", "/missing", "/orphan", "/posts/1", "/posts/2", "/posts/3", "/posts/4", "/posts/5", "/tags/a", "/tags/b", "/tags/c"]);
        assert.ok(page("/")?.browser, "browser facts on an HTML page");
        assert.equal(page("/feed.xml")?.browser, undefined);
        assert.equal(page("/missing")?.http.status, 404);
    });

    it("reads tags the page renders client-side", () => {
        assert.equal(page("/app/")?.html?.meta.description, "Rendered by the application shell once its script runs in a browser.");
    });

    it("records console errors and resources only the network log knows", () => {
        const app = page("/app/");
        assert.ok(app?.browser?.console.errors.includes("fixture: application shell error"));
        const runtime = app?.resources?.find((resource) => resource.url === `${site.origin}/runtime.png`);
        assert.deepEqual([runtime?.kind, runtime?.origin, runtime?.observed], ["image", "same", true], "loaded by script, absent from the static HTML");
        assert.equal(app?.resources?.find((resource) => resource.url.endsWith("/cdn/lib.js"))?.observed, true, "a request the browser blocked is still observed");
        assert.ok(report.findings.some((finding) => finding.rule === "browser/console-errors" && finding.url.endsWith("/app/")));
    });

    it("records the transport of each response", async () => {
        const redirected = await audit({ seeds: [`${site.origin}/old-about`], fetch: "browser", maxPages: 1, sitemap: false });
        const facts = redirected.pages[0];
        assert.equal(facts?.url.pathname, "/about");
        assert.equal(facts?.crawl.requested, `${site.origin}/old-about`);
        assert.deepEqual(facts?.http.redirects, [{ url: `${site.origin}/about` }]);
        assert.deepEqual(facts?.http.remote, { address: "127.0.0.1", family: "IPv4" });
        assert.equal(facts?.http.headers.server, "fixture-a");
        assert.equal(facts?.http.contentType, "text/html");
        assert.match(facts?.http.charset ?? "", /^utf-8$/);
        assert.equal(typeof facts?.http.timing.total, "number");
        assert.equal(typeof facts?.browser?.timing.load, "number");
    });

    it("judges a download by its headers", async () => {
        const download = await audit({ seeds: [`${site.origin}/big.bin`], fetch: "browser", maxPages: 1, sitemap: false });
        const http = download.pages[0]?.http;
        assert.equal(http?.status, 200);
        assert.equal(http?.contentType, "application/octet-stream");
        assert.equal(http?.size.declared, 50_000_000);
        assert.equal(http?.size.truncated, true);
    });
});
