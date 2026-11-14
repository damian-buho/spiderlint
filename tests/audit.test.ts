// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

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
import { serveOrigin, type Origin } from "./fixtures/origin.ts";
import { serveFraming, type Framing } from "./fixtures/framing.ts";
import { log } from "../src/logger.ts";
import { isOwnClock } from "../src/rules/clock.ts";
import type { RunEvent, RunState } from "../src/run.ts";

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
    return { rule: "http/csp/missing", severity: "warning" as const, scope: "page" as const, group: "default", url, message: "csp is absent" };
}

describe("audit", () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
    });

    after(() => site.close());

    const paths = () => report.pages.map((page) => page.url.pathname).toSorted((a, b) => a.localeCompare(b));
    const of = (rule: string) => report.findings.filter((finding) => finding.rule === rule);
    const cdn = () => site.origin.replace("//127.0.0.1:", "//localhost:");

    it("crawls every linked page in scope, and only those", () => {
        assert.deepEqual(paths(), ["/", "/about", "/app/", "/atom.xml", "/duplicate", "/feed.xml", "/missing", "/orphan", "/posts/1", "/posts/2", "/posts/3", "/posts/4", "/posts/5", "/tags/a", "/tags/b", "/tags/c"]);
        assert.ok(!site.requested.includes("/private/secret"), "robots.txt disallow is honoured");
        assert.ok(!site.requested.includes("/tmp/skipme"), "--exclude-urls is applied before enqueue");
    });

    it("crawls a head-only feed as a page and fetches the manifest as a resource", () => {
        const home = report.pages.find((page) => page.url.pathname === "/");
        const atom = report.pages.find((page) => page.url.pathname === "/atom.xml");
        assert.equal(atom?.crawl["discovered-via"], "link");
        assert.equal(atom?.html, undefined);
        const manifest = home?.resources?.find((resource) => resource.kind === "manifest");
        assert.equal(manifest?.url, `${site.origin}/site.webmanifest`);
        assert.equal(manifest?.http?.status, 200);
        assert.equal(manifest?.http?.["content-type"], "application/manifest+json");
    });

    it("fetches a sitemap-only page and facts every page against the sitemap", () => {
        const orphan = report.pages.find((page) => page.url.pathname === "/orphan");
        assert.equal(orphan?.crawl.depth, 0);
        assert.equal(orphan?.crawl["discovered-via"], "sitemap");
        assert.deepEqual(orphan?.sitemap, { listed: true, lastmod: "2026-09-01T00:00:00.000Z", changefreq: "monthly", priority: 0.3 });
        const home = report.pages.find((page) => page.url.pathname === "/");
        assert.equal(home?.crawl["discovered-via"], "seed");
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
        assert.ok(!Number.isNaN(Date.parse(home?.crawl.at ?? "")));
        assert.deepEqual(home?.crawl, {
            at: home?.crawl.at,
            mode: "http",
            depth: 0,
            "discovered-via": "seed",
            referrers: report.pages
                .filter((page) => page.http.status === 200 && page.html)
                .map((page) => page.url.href)
                .toSorted((a, b) => a.localeCompare(b)),
        });
        const post = report.pages.find((page) => page.url.pathname === "/posts/1");
        assert.equal(post?.crawl.depth, 1);
        assert.equal(post?.crawl["discovered-via"], "link");
    });

    it("reads robots.txt Crawl-delay for the spiderlint agent", async () => {
        const robots = robotsLoader(openBucket("robots", { cacheMode: "off", cacheTtl: {} }, undefined));
        assert.equal(crawlDelayOf(await robots(`${site.origin}/`)), 0.01);
    });

    it("reads every robots.txt field into the site facts", () => {
        assert.deepEqual(report.site.robots, [
            {
                url: `${site.origin}/robots.txt`,
                status: 200,
                groups: [
                    { agents: ["*"], allow: [], disallow: ["/private/"], "crawl-delay": 0.01 },
                    { agents: ["gptbot", "anthropic-ai"], allow: [], disallow: ["/"] },
                ],
                sitemaps: ["sitemap-broken.xml", "sitemap.xml", "sitemap-extra.xml.gz", "sitemap-gone.xml", "about.html"].map((file) => `${site.origin}/${file}`),
                "content-signals": [{ agents: ["*"], value: "search=yes, ai-train=no", signals: { search: "yes", "ai-train": "no" } }],
            },
        ]);
    });

    it("reads charset, head links, hreflang, JSON-LD, scripts and robots directives into facts", () => {
        const about = report.pages.find((page) => page.url.pathname === "/about");
        assert.equal(about?.html?.dir, "ltr");
        assert.match(about?.html?.charset?.declared ?? "", /^utf-8$/);
        assert.deepEqual(about?.html?.rels["privacy-policy"], [`${site.origin}/about`]);
        assert.ok((about?.html?.charset?.offset ?? 0) > 0 && (about?.html?.charset?.offset ?? 2048) < 1024, `offset ${about?.html?.charset?.offset}`);
        assert.deepEqual(
            about?.html?.head.links.find((link) => link.rel === "icon"),
            { rel: "icon", href: `${site.origin}/favicon.svg`, type: "image/svg+xml" },
        );
        assert.deepEqual(about?.html?.hreflang, [{ lang: "es", href: `${site.origin}/es/about` }]);
        assert.deepEqual(about?.html?.jsonld[0], { "@context": "https://schema.org", "@type": "AboutPage" });
        assert.ok(Object.hasOwn(about?.html?.jsonld[1] as object, "@error"));
        assert.deepEqual(about?.html?.scripts[0], { src: `${site.origin.replace("127.0.0.1", "localhost")}/cdn/lib.js`, async: false, defer: false, head: true });
        assert.deepEqual(about?.robots, { noindex: false, nofollow: true, noai: false });
        assert.ok(!site.requested.includes("/es/about"), "a head alternate is not a link to follow");
    });

    it("assigns each page to the first matching group", () => {
        const counts: Record<string, number> = {};
        for (const page of report.pages) counts[page.group] = (counts[page.group] ?? 0) + 1;
        assert.deepEqual(counts, { default: 7, app: 1, posts: 5, tags: 3 });
    });

    it("reports a dead in-scope link once, with its referrers", () => {
        const [dead, ...rest] = of("links/internal/unreachable");
        assert.equal(rest.length, 0);
        assert.equal(dead?.url, `${site.origin}/missing`);
        assert.equal(dead?.severity, "error");
        assert.equal(dead?.urls?.length, 12);
        assert.equal(dead?.message, "the page answers 404");
    });

    it("reports only the dead external link, and asks it again on the next run", async () => {
        const [dead, ...rest] = of("links/external/unreachable");
        assert.equal(rest.length, 0);
        assert.equal(dead?.url, `${cdn()}/gone`);
        assert.equal(dead?.message, "the link answers 404");
        assert.deepEqual(
            dead?.evidence?.map((read) => [read.bucket, read.via, Number.isNaN(Date.parse(read.at ?? ""))]),
            [["probes", "network", false]],
        );
        assert.deepEqual(dead?.urls, [`${site.origin}/about`]);
        const probes = () => site.requested.filter((pathname) => pathname === "/gone").length;
        assert.equal(probes(), 1);
        await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
        assert.equal(probes(), 2, "a broken answer is never stored");
    });

    it("never probes nor reports a link to an excluded host", async () => {
        const before = site.requested.filter((pathname) => pathname === "/gone").length;
        const excluded = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"], linkExclude: ["localhost"] });
        assert.equal(site.requested.filter((pathname) => pathname === "/gone").length, before);
        assert.deepEqual(
            excluded.findings.filter((finding) => finding.rule === "links/external/unreachable"),
            [],
        );
    });

    it("stores a bot wall answer and never judges it", async () => {
        const bucket = openBucket<LinkFacts>("probes", { cacheMode: "use", cacheTtl: {} }, undefined);
        const href = `${cdn()}/walled`;
        const first = await answerOf(href, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.deepEqual({ ...first, checked: undefined }, { status: 403, method: "HEAD", walled: true, checked: undefined });
        assert.ok(!Number.isNaN(Date.parse(first.checked ?? "")), "the answer says when it was probed");
        const second = await answerOf(href, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.equal(second.cached, true);
        const rule = builtin["links/external/unreachable"]?.("warning") as AggregateRule | undefined;
        const page = { url: new URL(`${site.origin}/`), html: { links: { external: [href] } } } as unknown as Facts;
        assert.deepEqual(rule?.check([page], undefined, { sitemaps: [], links: { [href]: first } } as unknown as SiteFacts), []);
    });

    it("reports links that reached nothing once per origin and error, keeping each page’s own links", () => {
        const rule = builtin["links/external/unreachable"]?.("warning") as AggregateRule | undefined;
        const lost = { status: 0, error: "getaddrinfo ENOTFOUND mirror.onion" };
        const links = { "http://mirror.onion/a/": lost, "http://mirror.onion/b/": lost, "http://mirror.onion/c/": lost, "http://other.onion/a/": { status: 0, error: "getaddrinfo ENOTFOUND other.onion" }, "http://slow.test/a/": { status: 0, error: "timeout" }, "http://slow.test/b/": { status: 0, error: "refused" } };
        const pages = [
            { url: new URL("https://site.test/a/"), html: { links: { external: ["http://mirror.onion/a/", "http://other.onion/a/", "http://slow.test/a/"] } } },
            { url: new URL("https://site.test/b/"), html: { links: { external: ["http://mirror.onion/b/", "http://mirror.onion/c/", "http://slow.test/b/"] } } },
        ] as unknown as Facts[];
        const found = rule?.check(pages, undefined, { sitemaps: [], links } as unknown as SiteFacts) ?? [];
        assert.deepEqual(
            found.map((finding) => [finding.url, finding.value, finding.urls?.length, finding.message]),
            [
                ["http://mirror.onion", 0, 2, "the link could not be reached: getaddrinfo ENOTFOUND mirror.onion"],
                ["http://other.onion", 0, 1, "the link could not be reached: getaddrinfo ENOTFOUND other.onion"],
                ["http://slow.test", 0, 1, "the link could not be reached: timeout"],
                ["http://slow.test", 0, 1, "the link could not be reached: refused"],
            ],
        );
        assert.deepEqual(found[0]?.data, { "https://site.test/a/": { link: "http://mirror.onion/a/" }, "https://site.test/b/": { link: "http://mirror.onion/b/, http://mirror.onion/c/" } });
        assert.deepEqual(
            found[0]?.evidence?.map((read) => read.key),
            ["http://mirror.onion/a/", "http://mirror.onion/b/", "http://mirror.onion/c/"],
        );
    });

    it("keeps one finding per target for links a server answered, on the same origin", () => {
        const rule = builtin["links/external/unreachable"]?.("warning") as AggregateRule | undefined;
        const page = { url: new URL("https://site.test/"), html: { links: { external: ["https://cdn.test/a", "https://cdn.test/b", "https://cdn.test/c"] } } } as unknown as Facts;
        const links = { "https://cdn.test/a": { status: 404 }, "https://cdn.test/b": { status: 404 }, "https://cdn.test/c": { status: 0, error: "timeout" } };
        const found = rule?.check([page], undefined, { sitemaps: [], links } as unknown as SiteFacts) ?? [];
        assert.deepEqual(
            found.map((finding) => finding.url),
            ["https://cdn.test/a", "https://cdn.test/b", "https://cdn.test"],
        );
    });

    it("treats a Cloudflare edge block that never asked the origin as a wall", async () => {
        const bucket = openBucket<LinkFacts>("probes", { cacheMode: "use", cacheTtl: {} }, undefined);
        const answer = await answerOf(`${cdn()}/edge-blocked`, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.deepEqual({ ...answer, checked: undefined }, { status: 403, method: "HEAD", walled: true, checked: undefined });
    });

    it("re-asks a fresh cached broken answer", async () => {
        const bucket = openBucket<LinkFacts>("probes", { cacheMode: "use", cacheTtl: {} }, undefined);
        const href = `${cdn()}/walled`;
        await bucket.set(href, { status: 403, method: "HEAD" });
        const answer = await answerOf(href, { allowPrivate: true, linkExclude: [] }, bucket, new AbortController().signal);
        assert.deepEqual({ ...answer, checked: undefined }, { status: 403, method: "HEAD", walled: true, checked: undefined });
    });

    it("stops the crawl at a bot wall and names its edge, and never at a plain 403", async () => {
        const options = { sitemap: false, rules: [], fold: false as const, cacheMode: "off" as const, concurrency: 1 };
        const walled = await audit({ ...options, seeds: [`${site.origin}/walled`] });
        const forbidden = await audit({ ...options, seeds: [`${site.origin}/forbidden`] });
        assert.deepEqual(
            walled.pages.map((page) => [page.url.pathname, page.http.walled]),
            [["/walled", "cloudflare"]],
        );
        assert.equal(walled.summary.walled, "cloudflare");
        assert.deepEqual(walled.site.crawl, { complete: false, reason: "walled" });
        assert.deepEqual([forbidden.pages[0]?.http.status, forbidden.summary.walled, forbidden.site.crawl], [403, undefined, { complete: true }]);
    });

    it("judges no SEO fact on a page outside 2xx", () => {
        const missing = report.pages.find((page) => page.url.pathname === "/missing");
        assert.equal(missing?.html?.title, "404");
        assert.deepEqual(
            report.findings.filter((finding) => finding.rule.startsWith("html/") && finding.url === missing?.url.href),
            [],
        );
    });

    it("keeps html rules off a non-HTML document", () => {
        const feed = report.pages.find((page) => page.url.pathname === "/feed.xml");
        assert.equal(feed?.http["content-type"], "application/xml");
        assert.equal(feed?.html, undefined);
        assert.deepEqual(
            report.findings.filter((finding) => finding.url === feed?.url.href || finding.samples?.includes(feed?.url.href ?? "")),
            [],
        );
    });

    it("folds a template-wide defect into one finding", () => {
        const [h1, ...rest] = of("html/h1/missing");
        assert.equal(rest.length, 0);
        assert.equal(h1?.group, "posts");
        assert.equal(h1?.occurrences, 5);
        assert.equal(h1?.coverage, 1);
        assert.equal(h1?.samples?.length, 3);
        assert.match(h1?.message ?? "", /^no <h1>$/);
    });

    it("keeps a one-page defect on its page", () => {
        const [alt, ...rest] = of("html/img-alt/missing");
        assert.equal(rest.length, 0);
        assert.equal(alt?.url, `${site.origin}/posts/3`);
        assert.match(alt?.message ?? "", /^an <img> has no alt attribute$/);
    });

    it("reports lengths with the actual value", () => {
        const [title] = of("html/title/length");
        assert.equal(title?.url, `${site.origin}/about`);
        assert.equal(title?.message, "<title> should be 30–60 characters");
        assert.deepEqual(title?.data, { [`${site.origin}/about`]: { got: "11 characters: “About page!”" } });
        assert.deepEqual(of("html/description/length"), []);
    });

    it("reports an absent value once, by its presence rule, never by the rules judging its text", () => {
        const [description, ...rest] = of("html/description/missing");
        assert.equal(rest.length, 0);
        assert.equal(description?.url, `${site.origin}/app/`);
        assert.equal(description?.message, "no meta description");
        assert.ok(of("html/description/redundant").every((finding) => finding.url !== `${site.origin}/app/`));
    });

    it("keeps each repeated meta name with its media, and flags a light and dark page with one theme-color", () => {
        const home = report.pages.find((page) => page.url.pathname === "/");
        assert.deepEqual(
            home?.html?.metas.filter((meta) => meta.name === "theme-color"),
            [
                { name: "theme-color", content: "#ffffff", media: "(prefers-color-scheme: light)" },
                { name: "theme-color", content: "#101010", media: "(prefers-color-scheme: dark)" },
            ],
        );
        assert.equal(home?.html?.meta["theme-color"], "#ffffff");
        assert.deepEqual(
            of("html/theme-color-dark/missing").map((finding) => finding.url),
            [`${site.origin}/about`],
        );
    });

    it("reports missing opengraph tags", () => {
        for (const rule of ["html/og-title/missing", "html/og-description/missing", "html/og-image/missing", "html/og-type/missing", "html/og-url/missing"]) {
            assert.deepEqual(
                of(rule).map((finding) => finding.url),
                [`${site.origin}/app/`],
                rule,
            );
        }
    });

    it("asks an article, never the home page, for an author and a publication date", () => {
        for (const rule of ["html/author/missing", "html/published-date/missing"]) {
            const urls = of(rule).flatMap((finding) => [finding.url, ...(finding.urls ?? []), ...(finding.samples ?? [])]);
            assert.ok(urls.includes(`${site.origin}/about`), rule);
            assert.ok(!urls.includes(`${site.origin}/`) && urls.every((url) => !url?.includes("/posts/")), rule);
        }
        const post = report.pages.find((page) => page.url.pathname === "/posts/1");
        assert.deepEqual([post?.html?.author, post?.html?.published], ["Fixture Author", "2026-09-01T12:00:00Z"]);
    });

    it("catches a templated title or description that repeats the same value twice", () => {
        const [title, ...restTitle] = of("html/title/redundant");
        assert.equal(restTitle.length, 0);
        assert.equal(title?.url, `${site.origin}/duplicate`);
        assert.equal(title?.message, "<title> repeats itself around a separator");
        const description = of("html/description/redundant").find((finding) => finding.url === `${site.origin}/duplicate`);
        assert.match(description?.message ?? "", /^meta description repeats itself around a separator$/);
    });

    it("reports an internal link answering a redirect once, with the pages carrying it, and counts them as referrers", () => {
        const [redirected, ...rest] = of("links/internal/redirected");
        assert.equal(rest.length, 0);
        assert.equal(redirected?.url, `${site.origin}/old-about`);
        assert.equal(redirected?.message, "the link redirects elsewhere");
        assert.deepEqual(redirected?.data, { [`${site.origin}/old-about`]: { landing: `${site.origin}/about` } });
        assert.deepEqual(redirected?.urls, [`${site.origin}/orphan`]);
        assert.ok(report.pages.find((page) => page.url.pathname === "/about")?.crawl.referrers.includes(`${site.origin}/orphan`));
    });

    it("reports a canonical or og:url naming another page", () => {
        const [canonical, ...restCanonical] = of("html/canonical/mismatch");
        assert.equal(restCanonical.length, 0);
        assert.equal(canonical?.url, `${site.origin}/about`);
        assert.equal(canonical?.message, "canonical link names another URL, not this page");
        assert.deepEqual(canonical?.data, { [`${site.origin}/about`]: { target: `${site.origin}/about/` } });
        const [ogUrl, ...restOgUrl] = of("html/og-url/mismatch");
        assert.equal(restOgUrl.length, 0);
        assert.equal(ogUrl?.url, `${site.origin}/orphan`);
        assert.equal(ogUrl?.severity, "info");
    });

    it("reports a value shared by two pages once, listing both", () => {
        for (const rule of ["html/title/duplicate", "html/description/duplicate", "html/og-title/duplicate", "html/og-description/duplicate"]) {
            const [finding, ...rest] = of(rule);
            assert.equal(rest.length, 0, rule);
            assert.equal(finding?.scope, "site");
            assert.deepEqual(
                finding?.urls?.toSorted((a, b) => a.localeCompare(b)),
                [`${site.origin}/tags/a`, `${site.origin}/tags/b`],
                rule,
            );
        }
    });

    it("runs only the rulesets a group names", () => {
        assert.deepEqual(
            report.findings.filter((finding) => finding.rule.startsWith("http/")),
            [],
        );
    });

    it("prints findings by group then rule", () => {
        const text = formatHuman(report);
        assert.ok(text.startsWith(`${site.origin}\npages `));
        assert.ok(!text.slice(site.origin.length).includes(`${site.origin}/`));
        assert.match(text, /^pages in group posts \(5 pages\)\n {2}error {3}7\.4 html\/h1\/missing — 5 pages \(100%\)/m);
        assert.match(text, /^\*\* whole site \*\* \(every page\)\n/m);
        assert.match(text, /^pages {6}16 \(15 × 200, 1 × 404\)\nsize {7}.+\ntime {7}.+\nrules {6}\d+\nchecks {5}499 of 558 passed\nfindings {3}\d+ \(\d+ errors, \d+ warnings, \d+ info\)\nrating {5}B \(seo, links\)\nhttp {7}17 fetches\nresources {2}\d+ requests\nextractors rel-me ×1\n\n/m);
        assert.ok(text.indexOf("rating     B (seo, links)") < text.indexOf("\n** whole site **"), "totals and rating come before the findings");
        assert.deepEqual(report.summary.cost.http, { pages: 17, revalidated: 0 });
    });

    it("colors severities when painted, and matches the plain text once styles are stripped", () => {
        const text = formatHuman(report, painter(process.stdout, true));
        assert.ok(text.includes("\u{1B}[31merror   7.4\u{1B}[39m"), text);
        assert.equal(stripVTControlCharacters(text), formatHuman(report));
    });

    it("bundles page findings sharing rule and message, one page per line", () => {
        const bundledReport = {
            pages: [stubPage("https://a.test/x"), stubPage("https://a.test/y"), stubPage("https://a.test/z")],
            findings: [stubCsp("https://a.test/y"), stubCsp("https://a.test/x"), { ...stubCsp("https://a.test/z"), message: "csp is weak" }],
            summary: { pages: 3, bytes: 0, durationMs: 0, groups: { default: 3 }, statuses: { 200: 3 }, findings: { total: 3, error: 0, warning: 3, info: 0 }, rules: 1, byRule: {}, checks: { total: 0, passed: 0, failed: 0, errored: 0 }, cost: { extractors: {} } },
        } as unknown as Report;
        const lines = formatHuman(bundledReport, undefined, false, "en").split("\n");
        const start = lines.findIndex((line) => line.includes("http/csp/missing"));
        assert.deepEqual(lines.slice(start - 1, start + 5), ["pages (3)", "  warning 5.0 http/csp/missing — 2 pages: csp is absent", "          /x", "          /y", "  warning 5.0 http/csp/missing — csp is weak", "          /z"]);
        assert.deepEqual(lines.slice(1, 7), ["pages      3 (3 × 200)", "size       0\u{A0}byte", "time       0\u{A0}sec", "rules      1", "checks     0 of 0 passed", "findings   3 (0 errors, 3 warnings, 0 info)"]);
        assert.deepEqual(formatHuman(bundledReport, undefined, false, "es").split("\n").slice(2, 4), ["size       0\u{A0}B", "time       0\u{A0}s"]);
        const previous = { started: "2026-09-24T12:00:00Z", findings: { total: 5, error: 1, warning: 3, info: 1, hint: 0 } };
        const progressed = formatHuman({ ...bundledReport, summary: { ...bundledReport.summary, previous } }).split("\n");
        assert.match(progressed.find((line) => line.startsWith("findings")) ?? "", /^findings {3}3 \u{2212}2 \(0 errors \u{2212}1, 3 warnings, 0 info \u{2212}1\) since .+$/u);
    });

    it("sums bytes, pages per group and per status into the run summary", () => {
        const { summary } = report;
        assert.equal(summary.pages, 16);
        assert.equal(
            summary.bytes,
            report.pages.reduce((sum, page) => sum + page.http.size.body, 0),
        );
        assert.deepEqual(summary.groups, { default: 7, app: 1, posts: 5, tags: 3 });
        assert.deepEqual(summary.statuses, { "200": 15, "404": 1 });
        assert.equal(summary.findings.total, summary.findings.error + summary.findings.warning + summary.findings.info);
        assert.ok(summary.rules >= new Set(report.findings.map((finding) => finding.rule).filter((rule) => rule !== "groups/heterogeneous")).size);
        assert.deepEqual(summary.checks, { total: 558, failed: 59, errored: 6, passed: 499, cost: 55.2048 });
        assert.deepEqual(summary.rating, { grade: "B", score: 0.9011, rulesets: ["seo", "links"] });
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
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"], sitemap: false });
        assert.ok(report.findings.filter((finding) => finding.rule === "html/canonical/mismatch").reduce((pages, finding) => pages + (finding.occurrences ?? 1), 0) > 1);
    });

    it("accepts the page’s twin, still flags a wrong path, and reads the production sitemap from the twin", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"], canonicalOrigin: production, fold: false });
        const of = (rule: string) => report.findings.filter((finding) => finding.rule === rule);
        assert.deepEqual(
            of("html/canonical/mismatch").map((finding) => [finding.url, finding.data?.[finding.url]?.target]),
            [[`${site.origin}/about`, `${production}/about/`]],
        );
        assert.deepEqual(
            of("html/og-url/mismatch").map((finding) => finding.url),
            [`${site.origin}/orphan`],
        );
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
        assert.equal(report.findings.filter((finding) => finding.rule === "html/h1/missing").length, 5);
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
        assert.equal(report.findings.filter((finding) => finding.rule === "http/hsts/weak").length, 0);
        const csp = report.findings.find((finding) => finding.rule === "http/csp/missing");
        assert.equal(csp?.occurrences, 16);
    });

    it("accepts either CSP frame-ancestors or X-Frame-Options against framing", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: { default: { rules: ["security-headers"] } }, fold: false });
        const framed = report.findings.filter((finding) => finding.rule === "http/frame-options/missing").map((finding) => new URL(finding.url).pathname);
        assert.equal(framed.length, 15);
        assert.ok(!framed.includes("/about") && !framed.includes("/posts/1"));
    });

    it("collects rel tokens per link, flags an internal nofollow and an affiliate link a declared policy wants sponsored", async () => {
        const rulesets = { rel: { extends: ["spiderlint:links"], rules: { "links/external-rel/missing": { severity: "warning" as const, expect: { "*.amazon.*": ["sponsored"] } } } } };
        const report = await audit({ seeds: [`${site.origin}/rel`], maxPages: 1, sitemap: false, fold: false, rulesets, groups: { default: { rules: ["rel"] } } });
        const links = report.pages[0]?.html?.links;
        assert.deepEqual(links?.sponsored, ["https://shop.amazon.test/dp/2"]);
        assert.deepEqual(links?.ugc, ["https://forum.test/t/1"]);
        assert.deepEqual(links?.rel, { [`${site.origin}/about`]: ["nofollow"], "https://forum.test/t/1": ["ugc", "nofollow"] });
        const found = report.findings.filter((finding) => finding.rule.startsWith("links/") && finding.rule !== "links/external/unreachable").map((finding) => [finding.rule, finding.value]);
        assert.deepEqual(found, [
            ["links/internal-nofollow/present", [`${site.origin}/about`]],
            ["links/external-rel/missing", { href: "https://www.amazon.test/dp/1", missing: ["sponsored"] }],
            ["links/external-rel/missing", { href: "https://shop.amazon.test/dp/2", missing: ["sponsored"] }],
        ]);
    });

    it("scopes a rel policy to the comments region, leaving the same link outside it alone", async () => {
        const rulesets = { rel: { extends: ["spiderlint:links"], rules: { "links/external-rel/missing": { severity: "warning" as const, expect: { "comments:*": ["ugc"] } } } } };
        const report = await audit({ seeds: [`${site.origin}/rel`], maxPages: 1, sitemap: false, fold: false, rulesets, groups: { default: { rules: ["rel"] } } });
        assert.deepEqual(report.pages[0]?.html?.links.regions, { comments: { "https://visitor.test/": [], "https://forum.test/t/1": ["ugc", "nofollow"] } });
        const found = report.findings.filter((finding) => finding.rule === "links/external-rel/missing").map((finding) => finding.value);
        assert.deepEqual(found, [{ href: "https://visitor.test/", missing: ["ugc"], region: "comments" }]);
    });

    it("judges a binary by its headers without downloading it", async () => {
        const report = await audit({ seeds: [`${site.origin}/big.bin`], maxPages: 1 });
        const size = report.pages[0]?.http.size;
        assert.equal(size?.declared, 50_000_000);
        assert.equal(size?.decoded, 0);
        assert.equal(size?.truncated, true);
        assert.ok((size?.body ?? 0) < 50_000_000, `received ${size?.body} bytes`);
    });

    it("keeps a compressed page’s coding and counts its bytes as received", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], maxPages: 1, sitemap: false, rules: ["performance"] });
        const http = report.pages[0]?.http;
        assert.equal(http?.headers["content-encoding"], "br");
        assert.ok((http?.size.body ?? 0) < (http?.size.decoded ?? 0), `received ${http?.size.body} of ${http?.size.decoded} bytes`);
        assert.match(report.pages[0]?.html?.title ?? "", /\S/);
        assert.ok(report.findings.every((finding) => finding.rule !== "http/compression/weak" || new URL(finding.url).pathname !== "/"));
    });

    it("fetches only the seeds when every rule reads site facts", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], sitemap: false, rules: ["robots/root/blocked"] });
        assert.deepEqual(
            report.pages.map((page) => page.url.pathname),
            ["/"],
        );
    });

    it("lints a 403 page instead of retrying it as blocked", async () => {
        const report = await audit({ seeds: [`${site.origin}/forbidden`], maxPages: 1, sitemap: false, rules: ["seo"] });
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
        assert.deepEqual(
            http?.redirects.map((hop) => [hop.url, hop.status, hop.headers?.location]),
            [[`${site.origin}/about`, 301, "/about"]],
        );
        assert.equal(report.pages[0]?.sitemap?.listed, true, "the sitemap entry follows the redirect");
        assert.equal(http?.version, "1.1");
        assert.equal(http?.remote?.address, "127.0.0.1");
        assert.ok((http?.timing.total ?? -1) >= 0);
        assert.equal(report.pages[0]?.tls, undefined);
    });

    it("keeps cookie flags and redacts cookie values", async () => {
        const report = await audit({ seeds: [`${site.origin}/orphan`], maxPages: 1, sitemap: false });
        const http = report.pages[0]?.http;
        assert.deepEqual(http?.cookies, [
            { name: "session", secure: false, "http-only": true, "same-site": "Lax", path: "/" },
            { name: "__Host-id", secure: true, "http-only": true, "same-site": "Strict", path: "/" },
        ]);
        assert.deepEqual(http?.headers["set-cookie"], ["session=[redacted]; Path=/; HttpOnly; SameSite=Lax", "__Host-id=[redacted]; Secure; Path=/; HttpOnly; SameSite=Strict"]);
        assert.ok(!JSON.stringify(report).includes("s3cr3t"));
    });

    it("judges a resource’s own Set-Cookie, keyed by the resource, and stores no value", async () => {
        const report = await audit({ seeds: [`${site.origin}/cookie-sources`], maxPages: 1, sitemap: false, groups: { default: { rules: ["cookies"] } } });
        const pixel = report.pages[0]?.resources?.find((resource) => resource.url.endsWith("/cookie-pixel.gif"));
        assert.deepEqual(pixel?.http?.cookies, [{ name: "__Secure-px", secure: false, "http-only": true, "same-site": "Lax", path: "/" }]);
        const findings = report.findings.filter((finding) => finding.rule.startsWith("cookies/resource-")).map((finding) => [finding.rule, new URL(finding.url).pathname, finding.value]);
        assert.deepEqual(findings, [["cookies/resource-secure-prefix/invalid", "/cookie-pixel.gif", ["__Secure-px"]]]);
        assert.ok(!JSON.stringify(report).includes("px=1"));
    });

    it("reports a __Host- cookie with a Domain or a narrower Path, and passes a correct one", async () => {
        const report = await audit({ seeds: [`${site.origin}/cookies`], maxPages: 1, sitemap: false, fold: false, groups: { default: { rules: ["cookies"] } } });
        assert.deepEqual(report.pages[0]?.http.cookies[0], { name: "__Host-bad", secure: true, "http-only": false, path: "/app", domain: "127.0.0.1" });
        assert.equal(report.findings.filter((finding) => finding.rule === "cookies/host-prefix/invalid").length, 1);
    });

    it("reports a __Secure- or SameSite=None cookie without Secure and one outliving 400 days, and passes correct ones", async () => {
        const report = await audit({ seeds: [`${site.origin}/cookies`, `${site.origin}/cookies-ok`], maxPages: 2, sitemap: false, fold: false, groups: { default: { rules: ["cookies"] } } });
        const ok = report.pages.find((page) => page.url.pathname === "/cookies-ok");
        assert.deepEqual(
            ok?.http.cookies.map((cookie) => cookie["max-age"]),
            [undefined, undefined, 3600, undefined],
        );
        for (const rule of ["cookies/secure-prefix/invalid", "cookies/same-site-none/insecure", "cookies/lifetime/excessive"]) {
            const paths = report.findings.filter((finding) => finding.rule === rule).map((finding) => new URL(finding.url).pathname);
            assert.deepEqual(paths, ["/cookies"], rule);
        }
    });

    it("records the status of each redirect hop and who answered it", async () => {
        const report = await audit({ seeds: [`${site.origin}/moved`], maxPages: 1, sitemap: false, groups: { default: { rules: ["redirects"] } } });
        assert.deepEqual(
            report.pages[0]?.http.redirects.map((hop) => [new URL(hop.url).pathname, hop.status, hop.by]),
            [
                ["/moving", 301, undefined],
                ["/about", 302, "fixture"],
            ],
        );
        assert.deepEqual(
            report.findings.map((finding) => [finding.rule, finding.message]),
            [["redirects/status/temporary", "reached through a temporary redirect"]],
        );
    });

    it("reports a one-way hreflang alternate, a missing one, and lang against Content-Language", async () => {
        const seeds = ["en", "es", "de"].map((lang) => `${site.origin}/i18n/${lang}`);
        const report = await audit({ seeds, maxPages: 3, sitemap: false, fold: false, groups: { default: { rules: ["i18n"] } } });
        const found = report.findings.map((finding) => [finding.rule, new URL(finding.url).pathname, finding.urls?.map((url) => new URL(url).pathname)]);
        assert.deepEqual(
            found.toSorted((a, b) => String(a).localeCompare(String(b))),
            [
                ["i18n/content-language/mismatch", "/i18n/es", undefined],
                ["i18n/hreflang-return/missing", "/i18n/es", ["/i18n/en"]],
                ["i18n/hreflang/unreachable", "/i18n/de", ["/i18n/en"]],
            ],
        );
    });

    it("keeps sitemap alternates and media, and reports a disagreeing hreflang and a dead image", async () => {
        const seeds = ["sitemap.xml", "en", "es"].map((name) => `${site.origin}/i18n/${name}`);
        const report = await audit({ seeds, maxPages: 5, fold: false, groups: { default: { rules: ["sitemap"] } } });
        const es = report.pages.find((page) => page.url.pathname === "/i18n/es");
        assert.deepEqual(es?.sitemap, { listed: true, alternates: [{ lang: "es", href: "/i18n/es" }], images: [`${site.origin}/favicon.ico`], videos: [`${site.origin}/favicon.ico`] });
        const found = report.findings.filter((finding) => finding.rule === "sitemap/hreflang/mismatch" || finding.rule === "sitemap/media/unreachable").map((finding) => [finding.rule, new URL(finding.url).pathname]);
        assert.deepEqual(
            found.toSorted((a, b) => String(a).localeCompare(String(b))),
            [
                ["sitemap/hreflang/mismatch", "/i18n/en"],
                ["sitemap/media/unreachable", "/i18n/missing.png"],
            ],
        );
    });

    it("records each 103 Early Hints Link, and reports a hinted preload the final response drops", async () => {
        const report = await audit({ seeds: [`${site.origin}/hints`, `${site.origin}/hints-ok`], maxPages: 2, sitemap: false, fold: false, groups: { default: { rules: ["performance"] } } });
        const hinted = report.pages.find((page) => page.url.pathname === "/hints");
        assert.deepEqual(hinted?.http["early-hints"], [{ link: "</style.css>; rel=preload; as=style, </font.woff2>; rel=preload; as=font" }]);
        const findings = report.findings.filter((finding) => finding.rule === "http/early-hints-preload/mismatch");
        assert.deepEqual(
            findings.map((finding) => [new URL(finding.url).pathname, finding.value]),
            [["/hints", [`${site.origin}/font.woff2`]]],
        );
    });

    it("finds a render-blocking origin nothing warms and a font preconnect without crossorigin", async () => {
        const report = await audit({ seeds: [`${site.origin}/preconnect-missing`, `${site.origin}/preconnect-font`, `${site.origin}/about`], maxPages: 3, sitemap: false, fold: false, groups: { default: { rules: ["html/preconnect*"] } } });
        const findings = report.findings.map((finding) => [finding.rule, new URL(finding.url).pathname, finding.value]).toSorted(([a], [b]) => String(a).localeCompare(String(b)));
        const cdn = site.origin.replace("127.0.0.1", "localhost");
        assert.deepEqual(findings, [
            ["html/preconnect-crossorigin/missing", "/preconnect-font", cdn],
            ["html/preconnect/missing", "/preconnect-missing", cdn],
        ]);
    });

    it("names itself in the user agent of every page, resource and robots.txt request", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, cacheMode: "off" });
        assert.ok(site.requested.slice(before).includes("/robots.txt"));
        const own = `spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`;
        const sent = site.headers.slice(before);
        const agents = new Set(sent.map((headers) => headers["user-agent"] ?? ""));
        for (const agent of agents) assert.ok(agent.endsWith(own), `tool named: ${agent}`);
        for (const headers of sent) {
            if (headers["user-agent"] !== own) continue;
            assert.ok(headers["sec-ch-ua"] !== undefined, "client hints travel with the user agent");
            assert.ok(headers["sec-ch-ua-mobile"] !== undefined, "client hints travel with the user agent");
            assert.ok(headers["sec-ch-ua-platform"] !== undefined, "client hints travel with the user agent");
        }
    });

    it("advertises the web instance in every user agent once told its host", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, cacheMode: "off", via: "Spiderlint.Kiota.CH:8443" });
        const seen = site.headers.slice(before).map((headers) => headers["user-agent"] ?? "");
        assert.ok(seen.length > 0);
        for (const agent of seen) assert.ok(agent.endsWith("; via spiderlint.kiota.ch)"), `instance named: ${agent}`);
    });

    it("asks for a fresh connection per page with --no-keepalive", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, sitemap: false, keepalive: false });
        assert.ok(site.headers.slice(before).some((headers) => headers.connection === "close"));
    });

    it("reports one host answering from two backends once", async () => {
        const report = await audit({ seeds: [`${site.origin}/`] });
        const [origin, ...rest] = report.findings.filter((finding) => finding.rule === "http/host/inconsistent");
        assert.equal(rest.length, 0);
        assert.match(origin?.message ?? "", /^Server header varies across 127\.0\.0\.1:\d+$/);
        assert.deepEqual(
            Object.values(origin?.data ?? {})
                .map((data) => String(data.value))
                .toSorted((a, b) => a.localeCompare(b)),
            [...Array.from({ length: 10 }, () => "fixture-a"), ...Array.from({ length: 5 }, () => "fixture-b")],
        );
        assert.equal(origin?.urls?.length, 15);
    });

    it("passes the tls, cookies and redirects presets on a clean page", async () => {
        const report = await audit({ seeds: [`${site.origin}/orphan`], maxPages: 1, sitemap: false, groups: { default: { rules: ["tls", "cookies", "redirects"] } } });
        assert.deepEqual(report.findings, []);
    });

    it("reports a sitemap page nothing links to, and a linked page no sitemap lists", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"], groups: { default: { rules: ["sitemap"] } }, fold: false });
        const paths = (rule: string) => report.findings.filter((finding) => finding.rule === rule).map((finding) => new URL(finding.url).pathname);
        assert.deepEqual(paths("sitemap/page/orphaned"), ["/orphan"]);
        assert.deepEqual(paths("sitemap/page/unlisted"), ["/duplicate"]);
        const unreadable = report.findings.filter((finding) => finding.rule === "sitemap/document/unreadable").map((finding) => [new URL(finding.url).pathname, finding.data?.[finding.url]?.error, finding.value]);
        assert.deepEqual(unreadable, [
            ["/sitemap-broken.xml", "does not parse: Unexpected close tag", 200],
            ["/sitemap-gone.xml", "answers 404", 404],
            ["/about.html", "is text/html, not a sitemap", 200],
        ]);
    });

    it("fetches sitemap files with the spiderlint user agent", async () => {
        const before = site.headers.length;
        await audit({ seeds: [`${site.origin}/about`], maxPages: 1, fetchResources: false });
        const agents = new Set(
            site.headers
                .slice(before)
                .filter((_, index) => site.requested[before + index]?.startsWith("/sitemap-"))
                .map((headers) => headers["user-agent"]),
        );
        assert.deepEqual([...agents], [`spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`]);
    });

    it("fetches a resource every page loads once, and reports it once", async () => {
        const before = site.requested.filter((path) => path === "/cdn/lib.js").length;
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: ["/tmp/**"] });
        assert.equal(site.requested.filter((path) => path === "/cdn/lib.js").length - before, 1);
        const statuses = report.findings.filter((finding) => finding.rule === "resources/resource/unreachable");
        assert.deepEqual(
            statuses.map((finding) => [finding.message, finding.urls?.length]).toSorted(([a], [b]) => String(a).localeCompare(String(b))),
            [
                ["image answers 404", 2],
                ["script answers 404", 13],
            ],
        );
        const status = statuses.find((finding) => finding.url.endsWith("/cdn/lib.js"));
        assert.match(status?.url ?? "", /^http:\/\/localhost:\d+\/cdn\/lib\.js$/);
        assert.equal(status?.message, "script answers 404");
        assert.equal(status?.urls?.length, 13);
        const sri = report.findings.filter((finding) => finding.rule === "resources/integrity/missing");
        assert.deepEqual(
            sri.map((finding) => finding.message),
            ["cross-origin script without integrity"],
        );
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

    it("drops an --exclude-rules rule entirely, across every group", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeRules: ["html/h1/missing"] });
        assert.equal(report.findings.filter((finding) => finding.rule === "html/h1/missing").length, 0);
    });

    it("applies a --error/--warning/--info override on top of the ruleset severity", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, fold: false, overrides: { "html/h1/missing": "info" } });
        const findings = report.findings.filter((finding) => finding.rule === "html/h1/missing");
        assert.equal(findings.length, 5);
        assert.ok(findings.every((finding) => finding.severity === "info"));
    });
});

describe("clock skew", () => {
    let ahead: Origin;
    let also: Origin;
    const clock = { rulesets: { clock: { rules: { "http/date/mismatch": "warning" as const } } }, groups: { default: { rules: ["clock"] } }, sitemap: false, cacheMode: "off" as const };

    before(async () => {
        [ahead, also] = await Promise.all([serveOrigin("skew"), serveOrigin("skew")]);
    });

    after(() => Promise.all([ahead.close(), also.close()]));

    it("reports a host whose Date runs 10 minutes ahead, leaving its cached page out", async () => {
        const report = await audit({ ...clock, seeds: [`${ahead.origin}/`, `${ahead.origin}/cached`] });
        const [finding, ...rest] = report.findings;
        assert.equal(rest.length, 0);
        assert.equal(finding?.rule, "http/date/mismatch");
        assert.ok(Math.abs((finding?.value as number) - 600) <= 2, `skew ${String(finding?.value)}`);
        assert.deepEqual(finding?.urls, [`${ahead.origin}/`]);
    });

    it("blames our own clock, once, when every host is off alike", async (t) => {
        const warn = t.mock.method(log, "warn");
        const report = await audit({ ...clock, seeds: [`${ahead.origin}/`, `${also.origin}/`] });
        assert.deepEqual(report.findings, []);
        assert.equal(warn.mock.calls.filter((call) => String(call.arguments[1]).startsWith("the local clock is off")).length, 1);
    });

    it("tells our clock from a host's only across two or more hosts skewed alike", () => {
        assert.equal(isOwnClock([600, 598, 601]), true);
        assert.equal(isOwnClock([600]), false);
        assert.equal(isOwnClock([600, -600]), false);
        assert.equal(isOwnClock([600, 30]), false);
        assert.equal(isOwnClock([600, 700]), false);
    });
});

// Rows in a stable order, and a URL with the fixture host masked.
const sorted = (rows: unknown[][]) => rows.toSorted((a, b) => a.join("\t").localeCompare(b.join("\t")));
const hosted = (url: string) => url.replace(/^(?:http:\/\/)?127\.0\.0\.1:\d+/, "HOST");

describe("content length", () => {
    let framing: Framing;

    before(async () => {
        framing = await serveFraming();
    });

    after(() => framing.close());

    it("reports each wrongly framed page host and resource, and leaves a 304 and an overlong body alone", async () => {
        const rulesets = { framing: { rules: { "http/content-length/invalid": "warning" as const, "links/internal/unreachable": "error" as const } } };
        const report = await audit({ seeds: [`${framing.origin}/`], rulesets, groups: { default: { rules: ["framing"] } }, sitemap: false, robots: false, cacheMode: "off", timeout: 10 });
        const found = report.findings.filter((finding) => finding.rule === "http/content-length/invalid").map((finding) => [hosted(finding.url), finding.message, finding.data?.[finding.url]?.detail]);
        assert.deepEqual(
            sorted(found),
            sorted([
                ["HOST", "the response sends Content-Length beside Transfer-Encoding", undefined],
                ["HOST", "a 204 response carries Content-Length", undefined],
                ["HOST", "the response body ended short of the bytes Content-Length declares", "body ended at 12 of the 400 bytes Content-Length declares"],
                ["HOST", "the response body does not match Content-Length, or Content-Length is sent twice or beside chunked", undefined],
                ["HOST/chunked.js", "script: the response body does not match Content-Length, or Content-Length is sent twice or beside chunked", undefined],
                ["HOST/short.js", "script: the response body ended short of the bytes Content-Length declares", "body ended at 7 of the 40 bytes Content-Length declares"],
                ["HOST/twice.js", "script: the response body does not match Content-Length, or Content-Length is sent twice or beside chunked", undefined],
            ]),
        );
        const broken = report.findings.filter((finding) => finding.rule === "links/internal/unreachable").map((finding) => [hosted(finding.url), finding.variables?.error]);
        assert.deepEqual(sorted(broken), [
            ["HOST/short", "Response body length does not match content-length header: body ended at 12 of the 400 bytes Content-Length declares"],
            ["HOST/twice", "Response body length does not match content-length header"],
        ]);
    });
});

describe("audit settling", () => {
    let site: Fixture;
    let report: Report;
    const events: RunEvent[] = [];
    let state: Readonly<RunState> | undefined;

    before(async () => {
        site = await serveFixture();
        report = await audit(
            { seeds: [`${site.origin}/`, `${site.origin}/preconnect-font`], groups: { ...GROUPS, default: { rules: ["seo", "links", "html/preconnect*"] } }, excludeUrls: ["/tmp/**"] },
            {
                observer: {
                    update: (now, event) => {
                        state = now;
                        events.push(event);
                    },
                },
            },
        );
    });

    after(() => site.close());

    const plan = () => (events.find((event) => event.type === "run.planned") as Extract<RunEvent, { type: "run.planned" }>).plan;
    const settled = () => events.filter((event) => event.type === "rules.checked");
    const cellsOf = (phases: string) => Object.entries(plan().groups).flatMap(([group, ids]) => ids.filter((id) => plan().rules[id]?.join(",") === phases).map((id) => [group, id] as const));

    it("settles a rule reading crawl and resources facts only after the resources, never after the crawl", () => {
        const cells = cellsOf("crawl,resources");
        assert.ok(cells.length > 0, "the plan holds a rule reading both phases");
        for (const [group, id] of cells) assert.equal(state?.rules[group]?.[id]?.phase, "resources", `${group} ${id}`);
        const early = settled().filter((event) => event.phase === "crawl");
        assert.ok(early.length > 0, "page rules settle after the crawl");
        for (const [group, id] of cells) for (const event of early) assert.equal(event.cells[group]?.[id], undefined, `${group} ${id} settled after the crawl`);
    });

    it("settles every cell exactly once, every site and group rule in the final pass", () => {
        const keys = settled().flatMap((event) => Object.entries(event.cells).flatMap(([group, verdicts]) => Object.keys(verdicts).map((id) => `${group} ${id}`)));
        const planned = Object.entries(plan().groups).flatMap(([group, ids]) => ids.map((id) => `${group} ${id}`));
        assert.deepEqual(
            keys.toSorted((a, b) => a.localeCompare(b)),
            planned.toSorted((a, b) => a.localeCompare(b)),
        );
        for (const [group, ids] of Object.entries(plan().groups)) for (const id of ids) if (plan().rules[id]?.at(-1) === "lint") assert.equal(state?.rules[group]?.[id]?.phase, "lint", `${group} ${id}`);
    });

    it("finds in some cell exactly the rules the report counts findings for, at the same total", () => {
        const totals = new Map<string, number>();
        const cells = Object.values(state?.rules ?? {}).flatMap((verdicts) => Object.entries(verdicts));
        for (const [id, verdict] of cells) totals.set(id, (totals.get(id) ?? 0) + Object.values(verdict.findings ?? {}).reduce((sum, count) => sum + count, 0));
        const site = new Set(Object.keys(plan().rules).filter((id) => plan().rules[id]?.at(-1) === "lint"));
        for (const [id, counts] of Object.entries(report.summary.byRule)) {
            const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
            if (site.has(id)) assert.equal((totals.get(id) ?? 0) > 0, total > 0, id);
            else assert.equal(totals.get(id) ?? 0, total, id);
        }
    });
});
