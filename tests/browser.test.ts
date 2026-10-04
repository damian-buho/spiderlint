// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, firefox, type BrowserType, type Request } from "playwright";
import { audit, type Report } from "../src/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { parsePin } from "../src/crawl/resolve.ts";
import { remoteFacts, tlsFacts, wireSize } from "../src/facts/browser.ts";
import type { AxeFacts } from "../src/plugins/axe.ts";
import type { KeyboardFacts } from "../src/plugins/keyboard.ts";
import type { LighthouseFacts } from "../src/plugins/lighthouse.ts";
import type { LiveFacts } from "../src/plugins/live.ts";
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

    it("reads an IPv6 peer without the brackets Chromium wraps it in", () => {
        assert.deepEqual(remoteFacts({ ipAddress: "[2606:4700:10::ac42:93f3]" }), { address: "2606:4700:10::ac42:93f3", family: "IPv6" });
        assert.deepEqual(remoteFacts({ ipAddress: "34.149.87.45" }), { address: "34.149.87.45", family: "IPv4" });
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
        report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["seo", "browser", "axe"], sample: "all" } }, excludeUrls: ["/tmp/**"] });
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
        const mixed = await audit({ seeds: [`${site.origin}/`], groups: { app: { match: ["/app/**"], fetch: "browser", rules: ["seo"] }, default: { rules: ["seo"] } }, excludeUrls: ["/tmp/**"] });
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
        const adaptive = await audit({ seeds: [`${site.origin}/`], fetch: "adaptive", groups: { app: { match: ["/app/**"] }, posts: { match: ["/posts/**"] }, default: {} }, rules: ["seo"], excludeUrls: ["/tmp/**"] });
        const posts = adaptive.pages.filter((entry) => entry.url.pathname.startsWith("/posts/"));
        assert.equal(adaptive.summary.fetch?.app, "browser");
        assert.equal(adaptive.summary.fetch?.posts, "http");
        assert.equal(adaptive.pages.find((entry) => entry.url.pathname === "/app/")?.html?.meta.description, "Rendered by the application shell once its script runs in a browser.");
        assert.deepEqual([posts.length, posts.filter((entry) => entry.browser).length], [5, 3], "three renders settle a group; the rest stay on http");
    });

    it("skips adaptive detection under the tor profile", async () => {
        const tor = await audit({ seeds: [`${site.origin}/`], fetch: "adaptive", profile: "tor", groups: { app: { match: ["/app/**"] }, default: {} }, rules: ["seo"], excludeUrls: ["/tmp/**"] });
        assert.deepEqual(tor.summary.fetch, { app: "http", default: "http" });
        assert.equal(tor.pages.filter((entry) => entry.browser).length, 0);
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
        assert.equal(facts?.http["content-type"], "text/html");
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

    it("finds a lazy hero four times its box and an eager image below the fold, and passes the clean twin", async () => {
        const gallery = await serveGallery();
        try {
            const live = await audit({ seeds: [`${gallery.origin}/live`, `${gallery.origin}/live-clean`], maxPages: 2, sitemap: false, robots: false, cacheMode: "off", groups: { default: { rules: ["images:live"], sample: "all" } } });
            const findings = live.findings.map((finding) => `${finding.rule} ${new URL(finding.url).pathname} ${(finding.locations ?? []).join(", ")}`).toSorted((a, b) => a.localeCompare(b));
            assert.equal(findings.length, 3, findings.join("; "));
            assert.match(findings[0] ?? "", /^images\/lazy-above-fold \/live \/wide\.jpg at \d+ px$/);
            assert.match(findings[1] ?? "", /^images\/lazy-below-fold \/live \/small\.webp at \d{4} px$/);
            assert.equal(findings[2], "images/rendered-oversize /live /wide.jpg 400 px shown at 100 px");
        } finally {
            await gallery.close();
        }
    });

    it("judges a download by its headers", async () => {
        const download = await audit({ seeds: [`${site.origin}/big.bin`], fetch: "browser", maxPages: 1, sitemap: false });
        const http = download.pages[0]?.http;
        assert.equal(http?.status, 200);
        assert.equal(http?.["content-type"], "application/octet-stream");
        assert.equal(http?.size.declared, 50_000_000);
        assert.equal(http?.size.truncated, true);
    });

    it("judges cookies scripts write through document.cookie, without their values", async () => {
        const written = await audit({ seeds: [`${site.origin}/cookie-sources`], maxPages: 1, sitemap: false, fetchResources: false, groups: { default: { rules: ["browser"] } } });
        assert.deepEqual(written.pages[0]?.browser?.cookies, [{ name: "tracker", secure: false, "http-only": false, "max-age": 99_999_999 }]);
        assert.deepEqual(written.findings.map((finding) => finding.rule).filter((rule) => rule.startsWith("cookies/")).toSorted((a, b) => a.localeCompare(b)), ["cookies/script-lifetime", "cookies/script-same-site"]);
    });

    it("finds a third-party cookie set before any interaction, and passes a page setting only a session cookie", async () => {
        const report = await audit({ seeds: [`${site.origin}/consent-tracked`, `${site.origin}/consent-clean`], maxPages: 2, sitemap: false, fetchResources: false, groups: { default: { rules: ["privacy"], sample: "all" } } });
        const tracked = report.pages.find((entry) => entry.url.pathname === "/consent-tracked");
        assert.deepEqual(tracked?.consent, { cookies: [{ name: "sid", domain: "127.0.0.1", party: "first" }, { name: "uid", domain: "localhost", party: "third", lifetime: (tracked?.consent as { cookies: { lifetime?: number }[] }).cookies[1]?.lifetime }], storage: [] });
        const findings = report.findings.filter((finding) => finding.rule === "cookies/before-consent").map((finding) => new URL(finding.url).pathname);
        assert.deepEqual(findings, ["/consent-tracked"]);
        assert.ok(!JSON.stringify(report.pages.map((entry) => entry.consent)).includes("uid=1"));
    });

    it("reads the consent jar on sampled pages only", async () => {
        const report = await audit({ seeds: [`${site.origin}/consent-tracked`, `${site.origin}/consent-clean`], maxPages: 2, sitemap: false, fetchResources: false, groups: { default: { rules: ["privacy"], sample: 1 } } });
        assert.equal(report.pages.filter((entry) => entry.consent !== undefined).length, 1);
    });

    it("walks keyboard, motion, dark and increased contrast, forced colours, listeners, fields and storage on a fresh page, failing every defect and passing the clean twin", async () => {
        const report = await audit({ seeds: ["/live-bad", "/live-clean", "/live-skip"].map((path) => `${site.origin}${path}`), maxPages: 3, sitemap: false, fetchResources: false, groups: { default: { rules: ["keyboard", "live", "privacy"], sample: "all" } } });
        const failed = report.findings.filter((finding) => finding.rule !== "groups/heterogeneous").map((finding) => `${new URL(finding.url).pathname} ${finding.rule}`).toSorted((a, b) => a.localeCompare(b));
        const bad = ["cookies/before-consent", "cookies/storage-before-consent", "keyboard/focus-obscured", "keyboard/focus-visible", "keyboard/forced-focus", "keyboard/skip-link", "keyboard/tab-walk", "live/click-listener", "live/contrast-enhanced", "live/dark-contrast", "live/forced-icons", "live/forced-opt-out", "live/input-font-size", "live/reduced-motion"];
        assert.deepEqual(failed, [...bad.map((rule) => `/live-bad ${rule}`), "/live-skip keyboard/tab-walk", "/live-skip live/contrast-more"]);
        const keyboard = (path: string) => report.pages.find((entry) => entry.url.pathname === path)?.keyboard as KeyboardFacts | undefined;
        assert.equal(keyboard("/live-bad")?.trap, "#a", "B sends Tab back to A");
        assert.deepEqual(keyboard("/live-skip")?.unreached.map((element) => element.target), ["#y"]);
        assert.deepEqual(keyboard("/live-clean")?.first, { target: "body > a", "in-main": false, "skips-to": { target: "#main", main: true } });
        assert.ok(keyboard("/live-clean")?.complete);
        assert.deepEqual(keyboard("/live-bad")?.stops.filter((stop) => stop.forced === false).map((stop) => stop.target), ["#ring"], "a box-shadow ring vanishes under forced colours");
        const live = (path: string) => report.pages.find((entry) => entry.url.pathname === path)?.live as LiveFacts | undefined;
        assert.deepEqual(live("/live-bad")?.forced.icons.map((element) => element.target), ["body > main > button:nth-of-type(2)", "body > main > button:nth-of-type(3)"], "gradient and masked icons vanish, text and inline SVG stay");
        assert.deepEqual(live("/live-bad")?.forced["opt-out"].map((element) => element.target), ["body > main > p:nth-of-type(2)"]);
        assert.equal((report.pages.find((entry) => entry.url.pathname === "/live-skip")?.live as { dark?: unknown } | undefined)?.dark, undefined, "a page claiming no dark scheme is not judged in one");
    });

    it("runs Lighthouse in the crawler’s Chromium on sampled pages only", async () => {
        const report = await audit({ seeds: [`${site.origin}/about`, `${site.origin}/live-clean`], maxPages: 2, sitemap: false, fetchResources: false, groups: { default: { rules: ["lighthouse"], sample: 1 } } });
        const audited = report.pages.map((entry) => entry.lighthouse as LighthouseFacts | undefined).filter((facts) => facts !== undefined);
        assert.equal(audited.length, 1);
        assert.equal(audited[0]?.["form-factor"], "mobile");
        assert.equal(typeof audited[0]?.scores.performance, "number");
        assert.equal(typeof audited[0]?.vitals.lcp, "number");
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

// A page loading `sheet` and nothing else.
const styled = (sheet: string) => `<!doctype html><html lang="en"><head><title>Styled</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${sheet}"></head><body><main><p>Hi</p><button>Go</button></main></body></html>`;

describe("rendered extractor cache", { skip }, () => {
    it("serves axe, keyboard and feeds from the cache while their inputs hold, and runs axe and keyboard again where a stylesheet changed", async () => {
        const styles: Record<string, string> = { "/a.css": "p { color: #111 }", "/b.css": "p { color: #222 }" };
        const server = createServer((request, response) => {
            const pathname = request.url ?? "/";
            const style = styles[pathname];
            if (style) return response.writeHead(200, { "content-type": "text/css" }).end(style);
            if (pathname === "/feed.xml") return response.writeHead(200, { "content-type": "application/rss+xml", link: "<https://hub.example/>; rel=hub" }).end('<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><guid>1</guid></item></channel></rss>');
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(styled(pathname === "/one" ? "/a.css" : "/b.css"));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const store = await mkdtemp(path.join(tmpdir(), "spiderlint-rendered-"));
        const options = { seeds: ["/one", "/two", "/feed.xml"].map((pathname) => `${origin}${pathname}`), maxPages: 3, sitemap: false, robots: false, fetchResources: false, groups: { default: { rules: ["axe", "keyboard", "feeds"], sample: "all" as const } } };
        try {
            await audit(options, { store });
            const second = await audit(options, { store });
            const unchanged = second.summary.cost;
            assert.deepEqual([unchanged.extractors.axe, unchanged.extractors.keyboard, unchanged.extractors.feed], [undefined, undefined, undefined], "nothing runs again");
            assert.deepEqual([unchanged.extractorsCached?.axe, unchanged.extractorsCached?.keyboard, unchanged.extractorsCached?.feed], [2, 2, 1]);
            styles["/a.css"] = "p { color: #333 }";
            const third = await audit(options, { store });
            const restyled = third.summary.cost;
            assert.deepEqual([restyled.extractors.axe, restyled.extractors.keyboard], [1, 1], "only the page loading the changed sheet runs again");
            assert.deepEqual([restyled.extractorsCached?.axe, restyled.extractorsCached?.keyboard], [1, 1]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(store, { recursive: true, force: true });
        }
    });
});

describe("rel=me in a browser", { skip }, () => {
    const servers: Server[] = [];
    const requested: string[] = [];
    let [profile, origin] = ["", ""];

    // A server answering each path from `pages`, else 404; its origin once listening.
    async function serve(pages: () => Record<string, string>): Promise<string> {
        const server = createServer((request, response) => {
            requested.push(request.url ?? "/");
            const body = pages()[request.url ?? "/"];
            response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
            response.end(body ?? "");
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    before(async () => {
        profile = await serve(() => ({ "/@script": `<html><body><script>document.body.innerHTML = '<a rel="me" href="${origin}/">Home</a>'</script></body></html>`, "/@none": "<html><body>nothing</body></html>", "/@blocked": "<html><body>nothing</body></html>", "/robots.txt": "User-agent: *\nDisallow: /@blocked\n" }));
        origin = await serve(() => ({ "/": `<html><body><a rel="me" href="${profile}/@script">Script</a><a rel="me" href="${profile}/@none">None</a><a rel="me" href="${profile}/@blocked">Blocked</a></body></html>` }));
    });

    after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

    it("counts a back-link a profile’s script adds, and flags once, as rendered, the profile that never links back", async () => {
        const report = await audit({ seeds: [`${origin}/`], rules: ["links/rel-me", "links/rel-me-rendered"], cacheMode: "off", sitemap: false, groups: { default: { rules: ["links/rel-me", "links/rel-me-rendered"], sample: "all" } } });
        assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.value]), [["links/rel-me-rendered", `${profile}/@none`]]);
        assert.ok(!requested.includes("/@blocked"), "robots.txt keeps the browser off a disallowed profile");
        const live = report.pages[0]?.["rel-me-live"] as { profiles: { url: string; error?: string }[] };
        assert.equal(live.profiles.find((entry) => entry.url === `${profile}/@blocked`)?.error, "robots.txt disallows it");
    });
});
