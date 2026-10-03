// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import { judgeContent } from "../src/plugins/feed-content.ts";
import { podcastGuid } from "../src/plugins/feeds.ts";
import { serveFeeds, type FeedSite } from "./fixtures/feeds.ts";

describe("feeds", () => {
    let site: FeedSite;
    let report: Report;
    const locations = (rule: string, path: string) => report.findings.find((finding) => finding.rule === rule && finding.url === `${site.origin}${path}`)?.locations?.map((line) => line.replaceAll(site.origin, ""));

    before(async () => {
        site = await serveFeeds();
        report = await audit({ seeds: [`${site.origin}/`], rules: ["feeds", "podcasts"], sitemap: false, robots: false, cacheMode: "off" });
    });

    after(() => site.close());

    it("fails each check on its failing feed and passes the conforming ones", () => {
        const found = report.findings.filter((finding) => !finding.rule.startsWith("groups/")).map((finding) => `${finding.rule} ${finding.url.replace(site.origin, "")}`).toSorted((a, b) => a.localeCompare(b));
        assert.deepEqual(found, [
            "feeds/absolute-url /old.json",
            "feeds/absolute-url /spec.xml",
            "feeds/archive /atom-bad.xml",
            "feeds/archive /spec.xml",
            "feeds/cache /spec.xml",
            "feeds/charset /old.json",
            "feeds/charset /spec.xml",
            "feeds/conditional-get /spec.xml",
            "feeds/content-type /atom-bad.xml",
            "feeds/date-format /atom-bad.xml",
            "feeds/date-format /spec.xml",
            "feeds/date-future /spec.xml",
            "feeds/discovery-type /feed.xml",
            "feeds/discovery-type /posts/1",
            "feeds/double-escaped /spec.xml",
            "feeds/duplicate-id /spec.xml",
            "feeds/email /spec.xml",
            "feeds/enclosure /cast-bad.xml",
            "feeds/enclosure /podcast.xml",
            "feeds/id-tracking /spec.xml",
            "feeds/item-canonical /joins.xml",
            "feeds/item-date /joins.xml",
            "feeds/item-id /old.json",
            "feeds/item-status /joins.xml",
            "feeds/item-title /joins.xml",
            "feeds/item-title /spec.xml",
            "feeds/itunes-image ",
            "feeds/itunes-required /podcast.xml",
            "feeds/json-version /old.json",
            "feeds/language /spec.xml",
            "feeds/media-type /plain.xml",
            "feeds/page-language /joins.xml",
            "feeds/permalink /spec.xml",
            "feeds/podcast-guid /podcast.xml",
            "feeds/podcast-locked /cast-bad.xml",
            "feeds/podcast-locked /podcast.xml",
            "feeds/raw-markup /mdx.xml",
            "feeds/relative-url /spec.xml",
            "feeds/required /atom-bad.xml",
            "feeds/required /old.json",
            "feeds/required /podcast.xml",
            "feeds/required /spec.xml",
            "feeds/stale /atom-bad.xml",
            "feeds/stylesheet /spec.xml",
            "feeds/template-leak /spec.xml",
            "feeds/title-markup /spec.xml",
            "feeds/unknown-element /spec.xml",
            "feeds/unsafe-html /spec.xml",
            "feeds/xslt /spec.xml",
        ]);
    });

    it("names each item delivering raw MDX and spares one quoting it in code", () => {
        assert.deepEqual(locations("feeds/raw-markup", "/mdx.xml"), [
            "item 1 content:encoded: <Callout>",
            "item 1 content:encoded: import Callout from '../components/Callout.astro'",
            "item 1 content:encoded: Markdown heading, bold, link: ## Why it matters",
        ]);
    });

    it("joins items to the pages they link, judging a redirected item once", () => {
        assert.deepEqual(locations("feeds/item-status", "/joins.xml"), ["item 1 /old redirects to /posts/1", "item 2 /missing answers 404"]);
        assert.deepEqual(locations("feeds/item-title", "/joins.xml"), ["item 3 “Second” against “Another name”"]);
        assert.deepEqual(locations("feeds/page-language", "/joins.xml"), ["/posts/2 is en, the feed es"]);
    });

    it("crawls the item links, stylesheet and archive pages a feed names", () => {
        const paths = new Set(report.pages.map((page) => page.url.pathname));
        for (const path of ["/posts/2", "/missing", "/missing.xsl", "/archive-0.xml", "/archive-1.xml"]) assert.ok(paths.has(path), path);
    });

    it("strips tracking parameters from item links before queueing them", () => {
        const feed = report.pages.find((page) => page.url.pathname === "/feed.xml")?.feed as { entries: { link: string }[] };
        assert.deepEqual(feed.entries.map((entry) => entry.link), [`${site.origin}/posts/1`]);
        assert.ok(report.pages.every((page) => !page.url.search.includes("utm_")));
    });

    it("passes a conforming podcast feed and faults every enclosure of a bad one", () => {
        assert.deepEqual(report.findings.filter((finding) => finding.url === `${site.origin}/cast.xml`).map((finding) => finding.rule), []);
        assert.deepEqual(locations("feeds/enclosure", "/cast-bad.xml"), [
            "item 1 /ep-length.mp3 serves 64 bytes, the feed declares 999999",
            "item 2 /ep-text.mp3 serves text/plain, the feed declares audio/mpeg",
            "item 3 /ep-plain.mp3 sends no Accept-Ranges: bytes",
            "item 4 /ep-gone.mp3 answers 404",
        ]);
        assert.deepEqual(locations("feeds/enclosure", "/podcast.xml"), ["item 1 /ep1.mp3 answers 404"]);
    });

    it("gives a feed with no enclosure no podcasts finding", () => {
        const podcasts = new Set(["feeds/enclosure", "feeds/itunes-required", "feeds/podcast-guid", "feeds/podcast-locked"]);
        assert.deepEqual(report.findings.filter((finding) => finding.url === `${site.origin}/feed.xml` && podcasts.has(finding.rule)), []);
    });

    it("names an unlocked podcast feed and spares a locked one", () => {
        const locked = report.findings.filter((finding) => finding.rule === "feeds/podcast-locked").map((finding) => `${finding.url.replace(site.origin, "")} ${finding.message}`);
        assert.deepEqual(locked, [
            "/cast-bad.xml rss podcast feed sets no podcast:locked, so any platform may import it",
            "/podcast.xml rss podcast feed sets no podcast:locked, so any platform may import it",
        ]);
    });

    it("probes a declared hub only when the websub opt-in is on", async () => {
        const off = await audit({ seeds: [`${site.origin}/`], rules: ["websub"], sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(off.findings, []);
        const on = await audit({ seeds: [`${site.origin}/`], rules: ["websub"], pluginSettings: { feeds: { websub: true } }, sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(on.findings.map((finding) => `${finding.rule} ${finding.url.replace(site.origin, "")}`), ["feeds/websub-hub "]);
        assert.match(on.findings[0]?.message ?? "", /dead-hub answers 404/);
    });
});

describe("feed content", () => {
    it("reads double escaping across entity boundaries and leaves template braces to template-leak", () => {
        const found = judgeContent({ field: "description", type: "html", value: "<p>&amp;lt;p&amp;gt; {{ name }}</p>" });
        assert.deepEqual(found, { "double-escaped": ["&lt;"], "template-leak": ["{{ name }}"] });
    });

    it("needs two Markdown signs, so a lone list or bold word is prose", () => {
        assert.deepEqual(judgeContent({ field: "content_text", type: "text", value: "A **bold** claim.\n- one item" }), {});
        assert.deepEqual(Object.keys(judgeContent({ field: "content_text", type: "text", value: "# Title\n\nA **bold** claim." })), ["raw-markup"]);
    });

    it("exempts relative URLs under an xml:base", () => {
        assert.deepEqual(judgeContent({ field: "content", type: "html", value: `<img src="a.png">`, base: "https://example.org/" }), {});
    });
});

describe("podcast GUID", () => {
    it("derives the Podcasting 2.0 example GUID from its feed URL", () => {
        assert.equal(podcastGuid("https://mp3s.nashownotes.com/pc20rss.xml"), "917393e3-1b1e-5cef-ace4-edaa54e1f810");
    });
});
