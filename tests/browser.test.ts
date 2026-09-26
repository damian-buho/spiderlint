// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chromium, firefox, type BrowserType, type Request } from "playwright";
import { audit, type Report } from "../src/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { parsePin } from "../src/crawl/resolve.ts";
import { tlsFacts, wireSize } from "../src/facts/browser.ts";
import type { AxeFacts } from "../src/plugins/axe.ts";
import { serveGallery } from "./fixtures/images.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

// The node tool image carries no browser; the spiderlint image carries Chromium, and its self-test runs these.
async function launchFailure(launcher: BrowserType): Promise<string | false> {
    try {
        const browser = await launcher.launch();
        await browser.close();
        return false;
    } catch (error) {
        return `${launcher.name()} does not launch: ${String(error).split("\n", 1)[0]}`;
    }
}

const skip = await launchFailure(chromium);

describe("browser tls facts", () => {
    it("spells protocols as Node does, whatever Chromium says", () => {
        assert.equal(tlsFacts({ protocol: "TLS 1.3" })?.protocol, "TLSv1.3");
        assert.equal(tlsFacts({ protocol: "TLS 1.2" })?.protocol, "TLSv1.2");
        assert.equal(tlsFacts({ protocol: "QUIC" })?.protocol, "TLSv1.3");
        assert.equal(tlsFacts({}), undefined, "a plain-http response has no protocol");
    });
});

// A request whose sizes and Content-Length are what the test names.
function sized(responseBodySize: number, contentLength?: string): Request {
    return { url: () => "https://example.test/", sizes: async () => ({ responseBodySize }), response: async () => ({ headerValue: async () => contentLength }) } as unknown as Request;
}

describe("browser wire size", () => {
    it("trusts a measured size and replaces a negative one with Content-Length, else the fallback", async () => {
        assert.equal(await wireSize(sized(16_407, "15635")), 16_407);
        assert.equal(await wireSize(sized(-1110, "13936"), 80_836), 13_936);
        assert.equal(await wireSize(sized(-1110), 80_836), 80_836);
        assert.equal(await wireSize(sized(-1110)), 0);
    });
});

describe("fetch mode", () => {
    it("refuses a browser rule under an http pin, naming it", async () => {
        await assert.rejects(audit({ seeds: ["http://127.0.0.1:9/"], fetch: "http", groups: { default: { rules: ["browser"] } } }), (error: Error) => error instanceof ConfigError && error.message.includes("rule browser/console-errors in group default"));
    });

    it("renders for a rule reading a browser-mode extractor’s facts, as an http pin shows", async () => {
        await assert.rejects(audit({ seeds: ["http://127.0.0.1:9/"], fetch: "http", groups: { default: { rules: ["axe"] } } }), (error: Error) => error instanceof ConfigError && error.message.includes("rule axe/image-alt in group default"));
    });

    it("stays on http when no rule reads a browser fact", async () => {
        const site = await serveFixture();
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false });
        await site.close();
        assert.equal(report.pages[0]?.browser, undefined);
        assert.equal(report.pages[0]?.http.version, "1.1");
    });

    it("refuses a group pinned above an http pin", async () => {
        await assert.rejects(audit({ seeds: ["http://127.0.0.1:9/"], fetch: "http", groups: { app: { match: ["/app/**"], fetch: "adaptive" } } }), (error: Error) => error instanceof ConfigError && error.message.includes("group app"));
    });
});

describe("browser fetch", { skip }, () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["seo", "browser", "axe"], sample: "all" } }, exclude: ["/tmp/**"] });
    });

    after(() => site.close());

    const page = (pathname: string) => report.pages.find((entry) => entry.url.pathname === pathname);

    it("renders when a rule reads a browser fact, crawling what http mode crawls", () => {
        const paths = report.pages.map((entry) => entry.url.pathname).toSorted((a, b) => a.localeCompare(b));
        assert.deepEqual(paths, ["/", "/about", "/app/", "/atom.xml", "/duplicate", "/feed.xml", "/missing", "/orphan", "/posts/1", "/posts/2", "/posts/3", "/posts/4", "/posts/5", "/tags/a", "/tags/b", "/tags/c"]);
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

    it("runs axe in the rendered page of every HTML page", () => {
        assert.equal(page("/feed.xml")?.axe, undefined);
        const { browser, extractors } = report.summary.cost;
        assert.equal(browser?.pages, 17, "the redirecting /old-about renders too");
        assert.equal(browser?.launches, 1);
        assert.equal(extractors.axe, 14);
        const alt = report.findings.filter((finding) => finding.rule === "axe/image-alt").map((finding) => new URL(finding.url).pathname);
        assert.ok(alt.includes("/posts/3") && !alt.includes("/posts/4"), `image-alt on ${alt.join(", ")}`);
        const finding = report.findings.find((entry) => entry.rule === "axe/image-alt");
        assert.deepEqual(finding?.locations, ['img <img src="/figure.png">']);
        const stored = page("/posts/3")?.axe as AxeFacts;
        assert.equal(stored.violations.find((violation) => violation.rule === "image-alt")?.nodes[0]?.xpath, "/html/body/img");
        assert.ok(Array.isArray(stored.incomplete) && stored.version.length > 0);
    });

    it("crawls a browser group and an http group side by side in one run", async () => {
        const mixed = await audit({ seeds: [`${site.origin}/`], groups: { app: { match: ["/app/**"], fetch: "browser", rules: ["seo"] }, default: { rules: ["seo"] } }, exclude: ["/tmp/**"] });
        const at = (pathname: string) => mixed.pages.find((entry) => entry.url.pathname === pathname);
        assert.deepEqual(mixed.summary.fetch, { app: "browser", default: "http" });
        assert.deepEqual(mixed.pages.map((entry) => entry.url.pathname).toSorted((a, b) => a.localeCompare(b)), ["/", "/about", "/app/", "/atom.xml", "/duplicate", "/feed.xml", "/missing", "/orphan", "/posts/1", "/posts/2", "/posts/3", "/posts/4", "/posts/5", "/tags/a", "/tags/b", "/tags/c"]);
        assert.equal(at("/app/")?.html?.meta.description, "Rendered by the application shell once its script runs in a browser.");
        assert.ok(at("/app/")?.browser);
        assert.equal(at("/about")?.browser, undefined);
        const { browser, http } = mixed.summary.cost;
        assert.deepEqual([browser?.pages, browser?.launches], [1, 1]);
        assert.equal(http?.pages, mixed.pages.length, "the redirecting /old-about is fetched too");
    });

    it("settles an adaptive group on the browser when rendering changes its tags, and on http when it does not", async () => {
        const adaptive = await audit({ seeds: [`${site.origin}/`], fetch: "adaptive", groups: { app: { match: ["/app/**"] }, posts: { match: ["/posts/**"] }, default: {} }, rules: ["seo"], exclude: ["/tmp/**"] });
        const posts = adaptive.pages.filter((entry) => entry.url.pathname.startsWith("/posts/"));
        assert.equal(adaptive.summary.fetch?.app, "browser");
        assert.equal(adaptive.summary.fetch?.posts, "http");
        assert.equal(adaptive.pages.find((entry) => entry.url.pathname === "/app/")?.html?.meta.description, "Rendered by the application shell once its script runs in a browser.");
        assert.deepEqual([posts.length, posts.filter((entry) => entry.browser).length], [5, 3], "three renders settle a group; the rest stay on http");
    });

    it("records the transport of each response", async () => {
        const redirected = await audit({ seeds: [`${site.origin}/old-about`], fetch: "browser", maxPages: 1, sitemap: false });
        const facts = redirected.pages[0];
        assert.equal(facts?.url.pathname, "/about");
        assert.equal(facts?.crawl.requested, `${site.origin}/old-about`);
        assert.deepEqual(facts?.http.redirects.map((hop) => [hop.url, hop.status]), [[`${site.origin}/about`, 301]]);
        assert.deepEqual(facts?.http.remote, { address: "127.0.0.1", family: "IPv4" });
        assert.equal(facts?.http.headers.server, "fixture-a");
        assert.equal(facts?.http.version, "1.1", "Chromium speaks HTTP/1.1 over plain text");
        assert.equal(redirected.summary.cost.browser?.tlsProbes, 0);
        assert.equal(facts?.http.contentType, "text/html");
        assert.match(facts?.http.charset ?? "", /^utf-8$/);
        assert.equal(typeof facts?.http.timing.total, "number");
        assert.equal(typeof facts?.browser?.timing.load, "number");
    });

    it("answers every resource the page loaded from the network log, fetching none of them again", async () => {
        const gallery = await serveGallery();
        try {
            const config = { seeds: [`${gallery.origin}/`], rules: ["images"], sitemap: false, robots: false, cacheMode: "off" as const };
            const [http, browser] = [await audit(config), await audit({ ...config, fetch: "browser" })];
            const requested = gallery.requested.slice(gallery.requested.lastIndexOf("/") + 1);
            assert.deepEqual(browser.summary.cost.resources, { requests: 0, cached: 0, logged: 4 });
            assert.deepEqual(requested.toSorted((a, b) => a.localeCompare(b)), ["/heavy.png", "/logo.svg", "/small.webp", "/wide.jpg"], "each image once, by the browser");
            assert.deepEqual(browser.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b)), http.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b)));
        } finally {
            await gallery.close();
        }
    });

    it("judges a download by its headers", async () => {
        const download = await audit({ seeds: [`${site.origin}/big.bin`], fetch: "browser", maxPages: 1, sitemap: false });
        const http = download.pages[0]?.http;
        assert.equal(http?.status, 200);
        assert.equal(http?.contentType, "application/octet-stream");
        assert.equal(http?.size.declared, 50_000_000);
        assert.equal(http?.size.truncated, true);
    });

    it("judges cookies scripts write through document.cookie, without their values", async () => {
        const written = await audit({ seeds: [`${site.origin}/cookie-sources`], maxPages: 1, sitemap: false, fetchResources: false, groups: { default: { rules: ["browser"] } } });
        assert.deepEqual(written.pages[0]?.browser?.cookies, [{ name: "tracker", secure: false, httpOnly: false, maxAge: 99_999_999 }]);
        assert.deepEqual(written.findings.map((finding) => finding.rule).filter((rule) => rule.startsWith("cookies/")).toSorted((a, b) => a.localeCompare(b)), ["cookies/script-lifetime", "cookies/script-same-site"]);
    });

    it("finds a third-party cookie set before any interaction, and passes a page setting only a session cookie", async () => {
        const report = await audit({ seeds: [`${site.origin}/consent-tracked`, `${site.origin}/consent-clean`], maxPages: 2, sitemap: false, fetchResources: false, groups: { default: { rules: ["privacy"], sample: "all" } } });
        const tracked = report.pages.find((entry) => entry.url.pathname === "/consent-tracked");
        assert.deepEqual(tracked?.consent, { cookies: [{ name: "sid", domain: "127.0.0.1", party: "first" }, { name: "uid", domain: "localhost", party: "third", lifetime: (tracked?.consent as { cookies: { lifetime?: number }[] }).cookies[1]?.lifetime }] });
        const findings = report.findings.filter((finding) => finding.rule === "cookies/before-consent").map((finding) => new URL(finding.url).pathname);
        assert.deepEqual(findings, ["/consent-tracked"]);
        assert.ok(!JSON.stringify(report.pages.map((entry) => entry.consent)).includes("uid=1"));
    });

    it("reads the consent jar on sampled pages only", async () => {
        const report = await audit({ seeds: [`${site.origin}/consent-tracked`, `${site.origin}/consent-clean`], maxPages: 2, sitemap: false, fetchResources: false, groups: { default: { rules: ["privacy"], sample: 1 } } });
        assert.equal(report.pages.filter((entry) => entry.consent !== undefined).length, 1);
    });

    it("renders a name pinned by --resolve through Chromium’s host resolver rules", async () => {
        const seed = `http://pinned.fixture:${new URL(site.origin).port}/about`;
        const pinned = await audit({ seeds: [seed], fetch: "browser", resolve: [parsePin("pinned.fixture:127.0.0.1")], maxPages: 1, sitemap: false, robots: false, fetchResources: false });
        assert.equal(pinned.pages[0]?.http.status, 200);
        assert.ok(pinned.pages[0]?.browser, "rendered, not fetched");
    });
});

describe("firefox fetch", { skip: await launchFailure(firefox) }, () => {
    it("renders in the browser the config names, axe included", async () => {
        const site = await serveFixture();
        const report = await audit({ seeds: [`${site.origin}/posts/3`], fetch: "browser", browser: "firefox", maxPages: 1, sitemap: false, rules: ["axe"] });
        await site.close();
        assert.equal(report.summary.cost.browser?.name, "firefox");
        assert.ok(report.findings.some((finding) => finding.rule === "axe/image-alt"));
    });
});
