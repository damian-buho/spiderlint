// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { VERSION } from "../src/agent.ts";
import { audit, type Report } from "../src/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { openBucket } from "../src/cache/index.ts";
import { answerOf } from "../src/crawl/links.ts";
import { crawlDelayOf, robotsLoader } from "../src/crawl/robots.ts";
import type { Facts, LinkFacts, SiteFacts } from "../src/facts/types.ts";
import { builtin } from "../src/rules/builtin.ts";
import type { AggregateRule } from "../src/rules/types.ts";
import { formatHuman } from "../src/report/human.ts";
import { painter } from "../src/color.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = {
    posts: { match: ["/posts/**"], rules: ["seo"] },
    tags: { match: ["re:^/tags/[a-z]$"], rules: ["seo"] },
    app: { match: ["/app/**"], rules: ["seo"] },
    default: { rules: ["seo", "links"] },
};

function stubPage(url: string) {
    return { url: new URL(url), group: "default" };
}

function stubCsp(url: string) {
    return { rule: "http/csp", severity: "warning" as const, scope: "page" as const, group: "default", url, message: "csp is absent" };
}

describe("audit", () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"] });
    });

    after(() => site.close());

    const paths = () => report.pages.map((page) => page.url.pathname).toSorted((a, b) => a.localeCompare(b));
    const of = (rule: string) => report.findings.filter((finding) => finding.rule === rule);
    const cdn = () => site.origin.replace("//127.0.0.1:", "//localhost:");

    it("crawls every linked page in scope, and only those", () => {
        assert.deepEqual(paths(), ["/", "/about", "/app/", "/duplicate", "/feed.xml", "/missing", "/orphan", "/posts/1", "/posts/2", "/posts/3", "/posts/4", "/posts/5", "/tags/a", "/tags/b", "/tags/c"]);
        assert.ok(!site.requested.includes("/private/secret"), "robots.txt disallow is honoured");
        assert.ok(!site.requested.includes("/tmp/skipme"), "--exclude is applied before enqueue");
    });

    it("fetches a sitemap-only page and facts every page against the sitemap", () => {
        const orphan = report.pages.find((page) => page.url.pathname === "/orphan");
        assert.equal(orphan?.crawl.depth, 0);
        assert.equal(orphan?.crawl.discoveredVia, "sitemap");
        assert.deepEqual(orphan?.sitemap, { listed: true, lastmod: "2026-09-01T00:00:00.000Z", changefreq: "monthly", priority: 0.3 });
        const home = report.pages.find((page) => page.url.pathname === "/");
        assert.equal(home?.crawl.discoveredVia, "seed");
        assert.deepEqual(home?.sitemap, { listed: true });
        const about = report.pages.find((page) => page.url.pathname === "/about");
        assert.deepEqual(about?.sitemap, { listed: true, lastmod: "2026-08-15T00:00:00.000Z" }, "listed only in the gzipped sitemap");
        const duplicate = report.pages.find((page) => page.url.pathname === "/duplicate");
        assert.deepEqual(duplicate?.sitemap, { listed: false });
    });

    it("records links, depth and referrers as facts", () => {
        const home = report.pages.find((page) => page.url.pathname === "/");
        assert.deepEqual(home?.html?.links.external, [`${cdn()}/`]);
        assert.ok(home?.html?.links.internal.includes(`${site.origin}/posts/1`));
        assert.deepEqual(home?.crawl, { depth: 0, discoveredVia: "seed", referrers: report.pages.filter((page) => page.http.status === 200 && page.html).map((page) => page.url.href) });
        const post = report.pages.find((page) => page.url.pathname === "/posts/1");
        assert.equal(post?.crawl.depth, 1);
        assert.equal(post?.crawl.discoveredVia, "link");
    });

    it("reads robots.txt Crawl-delay for the spiderlint agent", async () => {
        const robots = robotsLoader(openBucket("robots", { cacheMode: "off", cacheTtl: {} }, undefined));
        assert.equal(crawlDelayOf(await robots(`${site.origin}/`)), 0.01);
    });

    it("reads charset, head links, hreflang, JSON-LD, scripts and robots directives into facts", () => {
        const about = report.pages.find((page) => page.url.pathname === "/about");
        assert.equal(about?.html?.dir, "ltr");
        assert.match(about?.html?.charset?.declared ?? "", /^utf-8$/);
        assert.deepEqual(about?.html?.rels["privacy-policy"], [`${site.origin}/about`]);
        assert.ok((about?.html?.charset?.offset ?? 0) > 0 && (about?.html?.charset?.offset ?? 2048) < 1024, `offset ${about?.html?.charset?.offset}`);
        assert.deepEqual(about?.html?.head.links.find((link) => link.rel === "icon"), { rel: "icon", href: `${site.origin}/favicon.svg`, type: "image/svg+xml" });
        assert.deepEqual(about?.html?.hreflang, [{ lang: "es", href: `${site.origin}/es/about` }]);
        assert.deepEqual(about?.html?.jsonld[0], { "@context": "https://schema.org", "@type": "AboutPage" });
        assert.ok(Object.hasOwn(about?.html?.jsonld[1] as object, "@error"));
        assert.deepEqual(about?.html?.scripts[0], { src: `${site.origin.replace("127.0.0.1", "localhost")}/cdn/lib.js`, async: false, defer: false, head: true });
        assert.deepEqual(about?.robots, { noindex: false, nofollow: true });
        assert.ok(!site.requested.includes("/es/about"), "a head alternate is not a link to follow");
    });

    it("assigns each page to the first matching group", () => {
        const counts: Record<string, number> = {};
        for (const page of report.pages) counts[page.group] = (counts[page.group] ?? 0) + 1;
        assert.deepEqual(counts, { default: 6, app: 1, posts: 5, tags: 3 });
    });

    it("reports a dead in-scope link once, with its referrers", () => {
        const [dead, ...rest] = of("links/broken-internal");
        assert.equal(rest.length, 0);
        assert.equal(dead?.url, `${site.origin}/missing`);
        assert.equal(dead?.severity, "error");
        assert.equal(dead?.urls?.length, 12);
        assert.equal(dead?.message, "http.status is 404; linked from 12 pages");
    });

    it("reports only the dead external link, and asks it again on the next run", async () => {
        const [dead, ...rest] = of("links/broken-external");
        assert.equal(rest.length, 0);
        assert.equal(dead?.url, `${cdn()}/gone`);
        assert.equal(dead?.message, "answers 404; linked from 1 page");
        assert.deepEqual(dead?.urls, [`${site.origin}/about`]);
        const probes = () => site.requested.filter((pathname) => pathname === "/gone").length;
        assert.equal(probes(), 1);
        await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"] });
        assert.equal(probes(), 2, "a broken answer is never stored");
    });

    it("never probes nor reports a link to an excluded host", async () => {
        const before = site.requested.filter((pathname) => pathname === "/gone").length;
        const excluded = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"], linkExclude: ["localhost"] });
        assert.equal(site.requested.filter((pathname) => pathname === "/gone").length, before);
        assert.deepEqual(excluded.findings.filter((finding) => finding.rule === "links/broken-external"), []);
    });

    it("stores a bot wall answer and never judges it", async () => {
        const bucket = openBucket<LinkFacts>("probes", { cacheMode: "use", cacheTtl: {} }, undefined);
        const href = `${cdn()}/walled`;
        const first = await answerOf(href, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.deepEqual(first, { status: 403, method: "HEAD", walled: true });
        const second = await answerOf(href, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.equal(second.cached, true);
        const rule = builtin["links/broken-external"]?.("warning") as AggregateRule | undefined;
        const page = { url: new URL(`${site.origin}/`), html: { links: { external: [href] } } } as unknown as Facts;
        assert.deepEqual(rule?.check([page], undefined, { sitemaps: [], links: { [href]: first } } as unknown as SiteFacts), []);
    });

    it("judges no SEO fact on a page outside 2xx", () => {
        const missing = report.pages.find((page) => page.url.pathname === "/missing");
        assert.equal(missing?.html?.title, "404");
        assert.deepEqual(report.findings.filter((finding) => finding.rule.startsWith("html/") && finding.url === missing?.url.href), []);
    });

    it("keeps html rules off a non-HTML document", () => {
        const feed = report.pages.find((page) => page.url.pathname === "/feed.xml");
        assert.equal(feed?.http.contentType, "application/xml");
        assert.equal(feed?.html, undefined);
        assert.deepEqual(report.findings.filter((finding) => finding.url === feed?.url.href || finding.samples?.includes(feed?.url.href ?? "")), []);
    });

    it("folds a template-wide defect into one finding", () => {
        const [h1, ...rest] = of("html/one-h1");
        assert.equal(rest.length, 0);
        assert.equal(h1?.group, "posts");
        assert.equal(h1?.occurrences, 5);
        assert.equal(h1?.coverage, 1);
        assert.equal(h1?.samples?.length, 3);
        assert.match(h1?.message ?? "", /^should have exactly one <h1>, found 0 items$/);
    });

    it("keeps a one-page defect on its page", () => {
        const [alt, ...rest] = of("html/img-alt");
        assert.equal(rest.length, 0);
        assert.equal(alt?.url, `${site.origin}/posts/3`);
        assert.match(alt?.message ?? "", /^an <img> has no alt attribute: \{"src":"\/figure\.png"\}$/);
    });

    it("reports lengths with the actual value", () => {
        const [title] = of("html/title-length");
        assert.equal(title?.url, `${site.origin}/about`);
        assert.match(title?.message ?? "", /^<title> should be 30–60 characters, found 11 characters: “About page!”$/);
        assert.deepEqual(of("html/description-length"), []);
    });

    it("reports an absent value once, by its presence rule, never by the rules judging its text", () => {
        const [description, ...rest] = of("html/description");
        assert.equal(rest.length, 0);
        assert.equal(description?.url, `${site.origin}/app/`);
        assert.equal(description?.message, "no meta description");
        assert.ok(of("html/description-redundant").every((finding) => finding.url !== `${site.origin}/app/`));
    });

    it("keeps each repeated meta name with its media, and flags a light and dark page with one theme-color", () => {
        const home = report.pages.find((page) => page.url.pathname === "/");
        assert.deepEqual(home?.html?.metas.filter((meta) => meta.name === "theme-color"), [
            { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
            { name: "theme-color", content: "#101010", media: "(prefers-color-scheme: dark)" },
        ]);
        assert.equal(home?.html?.meta["theme-color"], "#ffffff");
        assert.deepEqual(of("html/theme-color-schemes").map((finding) => finding.url), [`${site.origin}/about`]);
    });

    it("reports missing opengraph tags", () => {
        for (const rule of ["html/og-title", "html/og-description", "html/og-image", "html/og-type", "html/og-url"]) {
            assert.deepEqual(of(rule).map((finding) => finding.url), [`${site.origin}/app/`], rule);
        }
    });

    it("catches a templated title or description that repeats the same value twice", () => {
        const [title, ...restTitle] = of("html/title-redundant");
        assert.equal(restTitle.length, 0);
        assert.equal(title?.url, `${site.origin}/duplicate`);
        assert.match(title?.message ?? "", /^<title> repeats itself around a separator: /);
        const description = of("html/description-redundant").find((finding) => finding.url === `${site.origin}/duplicate`);
        assert.match(description?.message ?? "", /^meta description repeats itself around a separator: /);
    });

    it("reports an internal link answering a redirect once, with the pages carrying it, and counts them as referrers", () => {
        const [redirected, ...rest] = of("links/redirected-internal");
        assert.equal(rest.length, 0);
        assert.equal(redirected?.url, `${site.origin}/old-about`);
        assert.equal(redirected?.message, `redirects to ${site.origin}/about; linked from 1 page`);
        assert.deepEqual(redirected?.urls, [`${site.origin}/orphan`]);
        assert.ok(report.pages.find((page) => page.url.pathname === "/about")?.crawl.referrers.includes(`${site.origin}/orphan`));
    });

    it("reports a canonical or og:url naming another page", () => {
        const [canonical, ...restCanonical] = of("html/canonical-self");
        assert.equal(restCanonical.length, 0);
        assert.equal(canonical?.url, `${site.origin}/about`);
        assert.equal(canonical?.message, `canonical link names ${site.origin}/about/, not this page`);
        const [ogUrl, ...restOgUrl] = of("html/og-url-self");
        assert.equal(restOgUrl.length, 0);
        assert.equal(ogUrl?.url, `${site.origin}/orphan`);
        assert.equal(ogUrl?.severity, "info");
    });

    it("reports a value shared by two pages once, listing both", () => {
        for (const rule of ["html/unique-title", "html/unique-description", "html/unique-og-title", "html/unique-og-description"]) {
            const [finding, ...rest] = of(rule);
            assert.equal(rest.length, 0, rule);
            assert.equal(finding?.scope, "site");
            assert.deepEqual(finding?.urls?.toSorted((a, b) => a.localeCompare(b)), [`${site.origin}/tags/a`, `${site.origin}/tags/b`], rule);
        }
    });

    it("runs only the rulesets a group names", () => {
        assert.deepEqual(report.findings.filter((finding) => finding.rule.startsWith("http/")), []);
    });

    it("prints findings by group then rule", () => {
        const text = formatHuman(report);
        assert.ok(text.startsWith(`${site.origin}\nsite\n`));
        assert.ok(!text.slice(site.origin.length).includes(`${site.origin}/`));
        assert.match(text, /^posts \(5 pages\)\n {2}error {3}html\/one-h1 — 5 pages \(100%\)/m);
        assert.match(text, /^site\n/m);
        assert.match(text, /\n\npages {6}15 \(14 × 200, 1 × 404\)\nsize {7}.+\ntime {7}.+\nrules {6}\d+\nchecks {5}298 of 345 passed\nfindings {3}\d+ \(\d+ errors, \d+ warnings, \d+ info\)\nrating {5}B \(seo, links\)\nhttp {7}16 fetches\nresources {2}\d+ requests$/);
        assert.deepEqual(report.summary.cost.http, { pages: 16, revalidated: 0 });
    });

    it("colors severities when painted, and matches the plain text once styles are stripped", () => {
        const text = formatHuman(report, painter(process.stdout, true));
        assert.ok(text.includes("\u{1B}[31merror  \u{1B}[39m"), text);
        assert.equal(stripVTControlCharacters(text), formatHuman(report));
    });

    it("bundles page findings sharing rule and message, one page per line", () => {
        const bundledReport = {
            pages: [stubPage("https://a.test/x"), stubPage("https://a.test/y"), stubPage("https://a.test/z")],
            findings: [stubCsp("https://a.test/y"), stubCsp("https://a.test/x"), { ...stubCsp("https://a.test/z"), message: "csp is weak" }],
            summary: { pages: 3, bytes: 0, durationMs: 0, groups: { default: 3 }, statuses: { 200: 3 }, findings: { total: 3, error: 0, warning: 3, info: 0 }, rules: 1, byRule: {}, checks: { total: 0, passed: 0, failed: 0, errored: 0 }, cost: { extractors: {} } },
        } as unknown as Report;
        const lines = formatHuman(bundledReport).split("\n");
        assert.deepEqual(lines.slice(2, 6), ["  warning http/csp — 2 pages: csp is absent", "          /x", "          /y", "  warning http/csp /z: csp is weak"]);
        assert.deepEqual(lines.slice(-3), ["findings   3 (0 errors, 3 warnings, 0 info)", "rating     – (no checks ran)", "fetch      none"]);
        const previous = { started: "2026-09-24T12:00:00Z", findings: { total: 5, error: 1, warning: 3, info: 1 } };
        const progressed = formatHuman({ ...bundledReport, summary: { ...bundledReport.summary, previous } }).split("\n");
        assert.match(progressed.at(-3) ?? "", /^findings {3}3 \u{2212}2 \(0 errors \u{2212}1, 3 warnings, 0 info \u{2212}1\) since .+$/u);
    });

    it("sums bytes, pages per group and per status into the run summary", () => {
        const { summary } = report;
        assert.equal(summary.pages, 15);
        assert.equal(summary.bytes, report.pages.reduce((sum, page) => sum + page.http.size.body, 0));
        assert.deepEqual(summary.groups, { default: 6, app: 1, posts: 5, tags: 3 });
        assert.deepEqual(summary.statuses, { "200": 14, "404": 1 });
        assert.equal(summary.findings.total, summary.findings.error + summary.findings.warning + summary.findings.info);
        assert.ok(summary.rules >= new Set(report.findings.map((finding) => finding.rule).filter((rule) => rule !== "groups/heterogeneous")).size);
        assert.deepEqual(summary.checks, { total: 345, failed: 47, errored: 6, passed: 298 });
        assert.deepEqual(summary.rating, { grade: "B", score: 0.8638, rulesets: ["seo", "links"] });
        assert.ok(summary.durationMs >= 0);
    });
});

describe("staging twin", () => {
    const production = "https://production.test";
    let site: Fixture;

    before(async () => {
        site = await serveFixture(production);
    });

    after(() => site.close());

    it("reports every self reference to the production origin without canonical-origin", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"], sitemap: false });
        assert.ok(report.findings.filter((finding) => finding.rule === "html/canonical-self").length > 1);
    });

    it("accepts the page’s twin, still flags a wrong path, and reads the production sitemap from the twin", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"], canonicalOrigin: production, fold: false });
        const of = (rule: string) => report.findings.filter((finding) => finding.rule === rule);
        assert.deepEqual(of("html/canonical-self").map((finding) => [finding.url, finding.message]), [[`${site.origin}/about`, `canonical link names ${production}/about/, not this page`]]);
        assert.deepEqual(of("html/og-url-self").map((finding) => finding.url), [`${site.origin}/orphan`]);
        assert.ok(site.requested.includes("/sitemap.xml"));
        assert.equal(report.pages.find((page) => page.url.href === `${site.origin}/orphan`)?.sitemap?.listed, true);
        assert.equal(report.pages[0]?.url.twin, `${production}/`);
    });
});

describe("audit options", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(() => site.close());

    it("keeps every per-page finding without folding", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, fold: false });
        assert.equal(report.findings.filter((finding) => finding.rule === "html/one-h1").length, 5);
    });

    it("counts the same findings in the summary whether folded or not", async () => {
        const unfolded = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, fold: false });
        const folded = await audit({ seeds: [`${site.origin}/`], groups: GROUPS });
        assert.equal(unfolded.summary.findings.total, unfolded.findings.length);
        assert.ok(folded.findings.some((finding) => finding.occurrences !== undefined));
        assert.deepEqual(folded.summary.findings, unfolded.summary.findings);
    });

    it("leaves a sitemap-only page unfetched with --no-sitemap", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], sitemap: false });
        assert.ok(report.pages.every((page) => page.url.pathname !== "/orphan"));
        assert.equal(report.pages.find((page) => page.url.pathname === "/")?.sitemap, undefined);
    });

    it("skips a when-guarded rule instead of failing it", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["security-headers"] } } });
        assert.equal(report.findings.filter((finding) => finding.rule === "http/hsts").length, 0);
        const csp = report.findings.find((finding) => finding.rule === "http/csp");
        assert.equal(csp?.occurrences, 15);
    });

    it("accepts either CSP frame-ancestors or X-Frame-Options against framing", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["security-headers"] } }, fold: false });
        const framed = report.findings.filter((finding) => finding.rule === "http/frame-options").map((finding) => new URL(finding.url).pathname);
        assert.equal(framed.length, 14);
        assert.ok(!framed.includes("/about") && !framed.includes("/posts/1"));
    });

    it("judges a binary by its headers without downloading it", async () => {
        const report = await audit({ seeds: [`${site.origin}/big.bin`], maxPages: 1 });
        const size = report.pages[0]?.http.size;
        assert.equal(size?.declared, 50_000_000);
        assert.equal(size?.decoded, 0);
        assert.equal(size?.truncated, true);
        assert.ok((size?.body ?? 0) < 50_000_000, `received ${size?.body} bytes`);
    });

    it("lints a 403 page instead of retrying it as blocked", async () => {
        const report = await audit({ seeds: [`${site.origin}/forbidden`], maxPages: 1, sitemap: false });
        assert.equal(report.pages[0]?.http.status, 403);
        assert.equal(site.requested.filter((path) => path === "/forbidden").length, 1);
    });

    it("truncates a parsed body at --max-body-size", async () => {
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, maxBodySize: 200 });
        const size = report.pages[0]?.http.size;
        assert.equal(size?.decoded, 200);
        assert.equal(size?.truncated, true);
        const whole = await audit({ seeds: [`${site.origin}/about`], maxPages: 1 });
        assert.equal(whole.pages[0]?.http.size.truncated, undefined);
        assert.equal(whole.pages[0]?.http.size.decoded, whole.pages[0]?.http.size.body);
    });

    it("records the transport of each response", async () => {
        const report = await audit({ seeds: [`${site.origin}/old-about`], maxPages: 1 });
        const http = report.pages[0]?.http;
        assert.equal(report.pages[0]?.url.pathname, "/about");
        assert.deepEqual(http?.redirects, [{ url: `${site.origin}/about` }]);
        assert.equal(report.pages[0]?.sitemap?.listed, true, "the sitemap entry follows the redirect");
        assert.equal(http?.version, "1.1");
        assert.equal(http?.remote?.address, "127.0.0.1");
        assert.ok((http?.timing.total ?? -1) >= 0);
        assert.equal(report.pages[0]?.tls, undefined);
    });

    it("keeps cookie flags and redacts cookie values", async () => {
        const report = await audit({ seeds: [`${site.origin}/orphan`], maxPages: 1, sitemap: false });
        const http = report.pages[0]?.http;
        assert.deepEqual(http?.cookies, [{ name: "session", secure: false, httpOnly: true, sameSite: "Lax" }]);
        assert.deepEqual(http?.headers["set-cookie"], ["session=[redacted]"]);
        assert.ok(!JSON.stringify(report).includes("s3cr3t"));
    });

    it("names itself in the user agent of every page, resource and robots.txt request", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, cacheMode: "off" });
        assert.ok(site.requested.slice(before).includes("/robots.txt"));
        const agents = new Set(site.headers.slice(before).map((headers) => headers["user-agent"]));
        assert.deepEqual([...agents], [`spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`]);
    });

    it("asks for a fresh connection per page with --no-keepalive", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, keepalive: false });
        assert.ok(site.headers.slice(before).some((headers) => headers.connection === "close"));
    });

    it("reports one host answering from two backends once", async () => {
        const report = await audit({ seeds: [`${site.origin}/`] });
        const [origin, ...rest] = report.findings.filter((finding) => finding.rule === "http/consistent-origin");
        assert.equal(rest.length, 0);
        assert.match(origin?.message ?? "", /^Server header varies across 127\.0\.0\.1:\d+: fixture-a \(9\), fixture-b \(5\)$/);
        assert.equal(origin?.urls?.length, 14);
    });

    it("passes the tls, cookies and redirects presets on a clean page", async () => {
        const report = await audit({ seeds: [`${site.origin}/orphan`], maxPages: 1, sitemap: false, groups: { default: { rules: ["tls", "cookies", "redirects"] } } });
        assert.deepEqual(report.findings, []);
    });

    it("reports a sitemap page nothing links to, and a linked page no sitemap lists", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], exclude: ["/tmp/**"], groups: { default: { rules: ["sitemap"] } }, fold: false });
        const paths = (rule: string) => report.findings.filter((finding) => finding.rule === rule).map((finding) => new URL(finding.url).pathname);
        assert.deepEqual(paths("sitemap/orphan"), ["/orphan"]);
        assert.deepEqual(paths("sitemap/unlisted"), ["/duplicate"]);
        const unreadable = report.findings.filter((finding) => finding.rule === "sitemap/unreadable").map((finding) => [new URL(finding.url).pathname, finding.message, finding.value]);
        assert.deepEqual(unreadable, [
            ["/sitemap-broken.xml", "sitemap does not parse: Unexpected close tag", 200],
            ["/sitemap-gone.xml", "sitemap answers 404", 404],
            ["/about.html", "sitemap is text/html, not a sitemap", 200],
        ]);
    });

    it("fetches sitemap files with the spiderlint user agent", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, fetchResources: false });
        const agents = new Set(site.headers.slice(before).filter((_, index) => site.requested[before + index]?.startsWith("/sitemap-")).map((headers) => headers["user-agent"]));
        assert.deepEqual([...agents], [`spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`]);
    });

    it("fetches a resource every page loads once, and reports it once", async () => {
        const before = site.requested.filter((path) => path === "/cdn/lib.js").length;
        const report = await audit({ seeds: [`${site.origin}/`], exclude: ["/tmp/**"] });
        assert.equal(site.requested.filter((path) => path === "/cdn/lib.js").length - before, 1);
        const statuses = report.findings.filter((finding) => finding.rule === "resources/status");
        assert.deepEqual(statuses.map((finding) => finding.message).toSorted((a, b) => a.localeCompare(b)), ["image answers 404; used by 2 pages", "script answers 404; used by 13 pages"]);
        const status = statuses.find((finding) => finding.url.endsWith("/cdn/lib.js"));
        assert.match(status?.url ?? "", /^http:\/\/localhost:\d+\/cdn\/lib\.js$/);
        assert.equal(status?.message, "script answers 404; used by 13 pages");
        assert.equal(status?.urls?.length, 13);
        const sri = report.findings.filter((finding) => finding.rule === "resources/sri");
        assert.deepEqual(sri.map((finding) => finding.message), ["cross-origin script without integrity; used by 13 pages"]);
    });

    it("skips resource fetches with --no-resources", async () => {
        const before = site.requested.filter((path) => path === "/cdn/lib.js").length;
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, fetchResources: false });
        assert.equal(site.requested.filter((path) => path === "/cdn/lib.js").length, before);
        assert.equal(report.pages[0]?.resources?.[0]?.http, undefined);
    });

    it("stops at --max-pages", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], maxPages: 1 });
        assert.equal(report.pages.length, 1);
    });

    it("rejects a misspelt schema keyword before crawling", async () => {
        const requests = site.requested.length;
        const rulesets = { bad: { rules: { "x/y": { fact: "html.title", expect: { minLenght: 3 } } } } };
        await assert.rejects(audit({ seeds: [`${site.origin}/`], rulesets, groups: { default: { rules: ["bad"] } } }), ConfigError);
        await assert.rejects(audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["missing"] } } }), /ruleset missing: not defined/);
        assert.equal(site.requested.length, requests);
    });

    it("drops a --disabled-rules rule entirely, across every group", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, disabledRules: ["html/one-h1"] });
        assert.equal(report.findings.filter((finding) => finding.rule === "html/one-h1").length, 0);
    });

    it("applies a --error/--warning/--info override on top of the ruleset severity", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, fold: false, overrides: { "html/one-h1": "info" } });
        const findings = report.findings.filter((finding) => finding.rule === "html/one-h1");
        assert.equal(findings.length, 5);
        assert.ok(findings.every((finding) => finding.severity === "info"));
    });
});
