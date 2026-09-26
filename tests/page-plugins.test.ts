// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import trackers from "../src/plugins/trackers.ts";
import type { Facts } from "../src/facts/types.ts";
import type { AggregateRule } from "../src/rules/types.ts";
import { serveSpec, type SpecSite } from "./fixtures/spec.ts";

// The locations of every finding of `rule`.
const everyLocation = (report: Report, rule: string) => report.findings.filter((finding) => finding.rule === rule).flatMap((finding) => finding.locations ?? []);

// Rule and path of each plugin finding, sorted.
function found(report: Report, origin: string): string[] {
    return report.findings.filter((finding) => !finding.rule.startsWith("groups/")).map((finding) => `${finding.rule} ${finding.url.replace(origin, "")}`).toSorted((a, b) => a.localeCompare(b));
}

describe("page plugins", () => {
    let site: SpecSite;
    let report: Report;

    before(async () => {
        site = await serveSpec();
        report = await audit({ seeds: [`${site.origin}/good`], rules: ["feeds", "structured-data", "manifest", "link-text", "markup"], sitemap: false, robots: false, cacheMode: "off" });
    });

    after(() => site.close());

    it("fails each check on its failing page and passes the rest", () => {
        assert.deepEqual(found(report, site.origin), [
            "feeds/item-id /noid.xml",
            "feeds/self /elsewhere.xml",
            "feeds/self /hub.json",
            "feeds/self /noid.xml",
            "feeds/websub /hub.json",
            "feeds/well-formed /bad.xml",
            "link-text/generic /bad",
            "link-text/generic /es/",
            "manifest/fields /bad.webmanifest",
            "manifest/icons /bad.webmanifest",
            "manifest/parse /broken.webmanifest",
            "markup/captions /bad",
            "markup/input-type /bad",
            "markup/lang-switcher /bad",
            "structured-data/breadcrumbs /gone",
            "structured-data/breadcrumbs /moved",
            "structured-data/consistent /bad",
            "structured-data/dates /bad",
            "structured-data/deprecated /bad",
            "structured-data/entities /#me",
            "structured-data/entities /#org",
            "structured-data/parse /bad",
            "structured-data/references /bad#nobody",
            "structured-data/required /bad",
        ]);
    });

    it("reads the self URL, hubs and item identifiers of each feed format", () => {
        const feed = (path: string) => report.pages.find((page) => page.url.href === `${site.origin}${path}`)?.feed;
        assert.deepEqual(feed("/feed.xml"), { format: "rss", self: `${site.origin}/feed.xml`, hubs: ["https://hub.example/"], items: 1, unidentified: [] });
        assert.deepEqual(feed("/atom.xml"), { format: "atom", self: `${site.origin}/atom.xml`, hubs: [], items: 1, unidentified: [] });
        assert.deepEqual(feed("/noid.xml"), { format: "rss", hubs: [], items: 2, unidentified: [2] });
    });

    it("names the missing properties and the offending links", () => {
        const locations = (rule: string) => report.findings.find((finding) => finding.rule === rule)?.locations;
        assert.deepEqual(locations("structured-data/required"), ["Event without startDate, location", "Recipe without image"]);
        assert.deepEqual(locations("markup/lang-switcher"), [`${site.origin}/es/ declares no lang for es`]);
        assert.deepEqual(locations("markup/input-type"), ["autocomplete=email on type=text"]);
        assert.match(report.findings.find((finding) => finding.rule === "manifest/fields")?.message ?? "", /lacks start_url, display, icons|lacks start_url, display/);
    });

    it("judges structured data against the page, the vocabulary and the rest of the site", () => {
        assert.deepEqual(everyLocation(report, "structured-data/consistent"), [`WebPage names ${site.origin}/elsewhere, the canonical is ${site.origin}/bad`, "WebPage “Something else” appears in neither the title nor og:title"]);
        assert.deepEqual(report.findings.find((finding) => finding.rule === "structured-data/references")?.urls, [`${site.origin}/bad`]);
        assert.deepEqual(everyLocation(report, "structured-data/deprecated"), ["property ingredients → recipeIngredient", "type Taxi → TaxiService"]);
        assert.deepEqual(everyLocation(report, "structured-data/dates"), ["Article dateCreated “yesterday” is not ISO 8601", "Article dateModified 2026-09-01 is before datePublished 2026-09-02"]);
        assert.deepEqual(everyLocation(report, "structured-data/entities").toSorted((a, b) => a.localeCompare(b)), ["Corporation on 1 page", `${site.origin}/#me on 1 page`, `${site.origin}/bad#me on 1 page`, "Organization on 1 page"]);
    });

    it("reads Microdata and RDFa items into the JSON-LD node shape", () => {
        const good = report.pages.find((page) => page.url.href === `${site.origin}/good`);
        assert.deepEqual(good?.structureddata, {
            microdata: [{ "@type": ["Person"], "@id": `${site.origin}/#me`, name: "Ana" }],
            rdfa: [{ "@type": ["Event"], name: "Talk", startDate: "2026-10-01", location: { "@type": ["Place"], name: "Hall" } }],
        });
    });

    it("judges link text only in a language it has phrases for", () => {
        const german = report.pages.find((page) => page.url.href === `${site.origin}/de`);
        assert.ok(german?.html);
        assert.equal(german.linktext, undefined);
    });
});

// A page loading scripts from `urls`.
const page = (href: string, urls: string[]) => ({ url: { href }, resources: urls.map((url) => ({ url, kind: "script", origin: "cross" })) }) as unknown as Facts;

describe("trackers/inventory", () => {
    const rule = trackers.rules?.["trackers/inventory"]?.("info") as AggregateRule;

    it("lists each vendor once with its hosts and pages, and ignores other hosts", () => {
        const findings = rule.check([page("https://a.test/", ["https://www.googletagmanager.com/gtag.js", "https://cdn.a.test/app.js"]), page("https://a.test/b", ["https://www.google-analytics.com/g.js", "https://notclarity.ms/x.js"])]) ?? [];
        assert.deepEqual(findings.map(({ message, urls }) => ({ message, urls })), [{ message: "Google Analytics loads from www.googletagmanager.com, www.google-analytics.com on 2 pages", urls: ["https://a.test/", "https://a.test/b"] }]);
    });
});
