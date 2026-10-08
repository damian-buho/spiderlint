// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, crawl, lintStore, loadPlugins } from "../src/index.ts";
import { ConfigError, defaults } from "../src/config/index.ts";
import type { Facts } from "../src/facts/types.ts";
import htmlValidate, { type HtmlValidateFacts } from "../src/plugins/html-validate.ts";
import htmlhint, { type HtmlHintFacts } from "../src/plugins/htmlhint.ts";
import { formatHuman } from "../src/report/human.ts";
import { listPresets, listRules } from "../src/rules/catalog.ts";
import { resolveRuleset } from "../src/rules/rulesets.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const EXCLUDE = ["/tmp/**"];

// A minimal HTML page’s facts, rendered in Chromium when `isBrowser`.
function stubPage(isBrowser: boolean, isTruncated = false): Facts {
    const http = { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 1, decoded: 1, ...(isTruncated && { truncated: true as const }) }, "content-type": "text/html" };
    const html = { h1: [], meta: {}, metas: [], property: {}, head: { links: [] }, hreflang: [], jsonld: [], scripts: [], links: { internal: [], external: [], nofollow: [] }, images: [], rels: {}, inputs: [] };
    const browser = { timing: {}, console: { errors: [], warnings: [] }, weight: {}, cookies: [] };
    return { url: { href: "https://example.test/", origin: "https://example.test", protocol: "https:", host: "example.test", pathname: "/", search: "" }, group: "default", crawl: { depth: 0, "discovered-via": "seed", referrers: [] }, http, html, ...(isBrowser && { browser }) };
}

const BODY = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><input type="checkbox" id="c" disabled=""><label for="c">c</label></main></body></html>';
const extractor = htmlValidate.extractors?.[0];

// The html-validate rules that fail BODY, as served or as Chromium renders it.
async function failing(isBrowser: boolean): Promise<string[]> {
    const facts = (await extractor?.extract(stubPage(isBrowser), BODY)) as HtmlValidateFacts;
    return facts.messages.map((message) => message.rule);
}

describe("html-validate extractor", () => {
// The html-validate rules that fail a page whose only anchor carries `id`.
async function idRules(id: string): Promise<string[]> {
    const body = `<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><main><a id="${id}" href="/">x</a></main></body></html>`;
    const facts = (await extractor?.extract(stubPage(false), body)) as HtmlValidateFacts;
    return facts.messages.map((message) => message.rule);
}

    it("drops the serialisation-style rules for a rendered DOM", async () => {
        const served = await failing(false);
        const rendered = await failing(true);
        assert.ok(served.includes("attribute-boolean-style"));
        assert.ok(!rendered.includes("attribute-boolean-style"));
    });

    it("skips a truncated body, whose cut-off elements would all fail", async () => {
    it("accepts an ID the HTML standard allows, a leading underscore included, and refuses one with whitespace", async () => {
        const [underscore, spaced] = await Promise.all([idRules("_aria_auto_id_31"), idRules("two words")]);
        assert.ok(!underscore.includes("valid-id"));
        assert.ok(spaced.includes("valid-id"));
    });

        assert.equal(await extractor?.extract(stubPage(false, true), BODY), undefined);
    });
});

describe("htmlhint extractor", () => {
    const hinter = htmlhint.extractors?.[0];

    it("reports unpaired tags and duplicate IDs with their line, column and tag", async () => {
        const body = '<!DOCTYPE html><html lang="en"><head><title>t</title></head><body><p id="a"><b>x</p><p id="a">y</p></body></html>';
        const facts = (await hinter?.extract(stubPage(false), body)) as HtmlHintFacts;
        const pair = facts.messages.find((message) => message.rule === "tag-pair");
        assert.deepEqual([pair?.line, pair?.source], [1, "</p>"]);
        assert.ok(facts.messages.some((message) => message.rule === "id-unique"));
    });

    it("skips a truncated body, whose cut-off tags would all fail", async () => {
        assert.equal(await hinter?.extract(stubPage(false, true), BODY), undefined);
    });
});

describe("rulesets", () => {
    it("links docs from every shipped rule but the site-specific consistent-origin and minority-value", () => {
        const bare = listRules({ ...defaults(), rules: ["all"] }, ["all"])
            .filter((rule) => !rule.docs)
            .map((rule) => rule.id);
        assert.deepEqual(bare, ["http/consistent-origin", "insight/minority-value"]);
    });

    it("merges an overriding expect into the extended one, keyword by keyword", () => {
        const title = resolveRuleset("site", { site: { extends: ["seo"], rules: { "html/title-length": { expect: { minLength: 25 } } } } })["html/title-length"];
        assert.deepEqual(title?.expect, { type: "string", minLength: 25, maxLength: 60 });
        assert.equal(title?.fact, "html.title");
        assert.equal(title?.message, undefined);
    });

    it("keeps the extended message when an override leaves expect alone", () => {
        const title = resolveRuleset("site", { site: { extends: ["seo"], rules: { "html/title-length": "error" } } })["html/title-length"];
        assert.match(title?.message ?? "", /30–60 characters/);
    });
});

describe("plugins", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-plugins-"));
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("validates every HTML page once a rule reads htmlvalidate, and reports each rule on its own", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["html-validate"], fold: false, cacheMode: "off" });
        const validated = new Set(report.pages.filter((page) => page.htmlvalidate !== undefined).map((page) => page.url.pathname));
        assert.ok(validated.has("/posts/3") && !validated.has("/feed.xml"));
        const alt = report.findings.find((finding) => finding.rule === "html-validate/wcag/h37" && finding.url.endsWith("/posts/3"));
        assert.match(alt?.message ?? "", /alt/);
        assert.ok(((alt?.value as { line: number }[])[0]?.line ?? 0) > 0);
        assert.match(alt?.locations?.[0] ?? "", /^\d+:\d+ .*img <img src="\/figure\.png">$/);
    });

    it("keeps the locations of each folded sample page and prints them under it", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["html-validate"], cacheMode: "off" });
        const sri = report.findings.find((finding) => finding.rule === "html-validate/require-sri");
        const first = sri?.sampleLocations?.[sri.samples?.[0] ?? ""] ?? [];
        assert.match(first[0] ?? "", /<script src="[^"]+\/cdn\/lib\.js">/);
        assert.equal(sri?.locations, undefined, "a fold carries no single page’s locations");
        assert.ok(formatHuman(report).includes(`at ${first[0]}`));
    });

    it("hints every HTML page once a rule reads htmlhint, each htmlhint rule on its own", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["htmlhint", "htmlhint:extra"], fold: false, cacheMode: "off" });
        assert.ok(report.pages.some((page) => page.htmlhint !== undefined) && report.pages.every((page) => page.htmlhint === undefined || page.html !== undefined));
        const alt = report.findings.find((finding) => finding.rule === "htmlhint/alt-require" && finding.url.endsWith("/posts/3"));
        assert.equal(alt?.severity, "warning");
        assert.match(alt?.locations?.[0] ?? "", /^\d+:\d+ <img src="\/figure\.png">$/);
    });

    it("runs no extractor no enabled rule reads", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"], cacheMode: "off" });
        assert.ok(report.pages.every((page) => page.htmlvalidate === undefined && page.htmlhint === undefined));
    });

    it("validates stored bodies on lint, so a crawl made without the rules needs no re-crawl", async () => {
        const store = path.join(directory, "store");
        await crawl({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"] }, store);
        const linted = await lintStore({ rules: ["html-validate"] }, store);
        assert.ok(linted.findings.some((finding) => finding.rule.startsWith("html-validate/")));
    });

    it("loads a plugin by path, with its extractor, rule and preset", async () => {
        await loadPlugins(["./tests/fixtures/plugin.ts"]);
        assert.ok(listPresets(defaults()).some((preset) => preset.name === "words"));
        assert.equal(resolveRuleset("all", {})["words/enough"]?.severity, "warning");
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["words"], cacheMode: "off" });
        assert.ok(report.pages.every((page) => page.words !== undefined));
        assert.deepEqual(
            report.findings.map((finding) => new URL(finding.url).pathname),
            ["/missing"],
        );
    });

    it("keeps all for every shipped rule, refusing a ruleset that takes the name", () => {
        assert.throws(() => resolveRuleset("all", { all: { rules: {} } }), ConfigError);
    });

    it("refuses a plugin redefining a rule, and one that cannot be imported", async () => {
        const clash = path.join(directory, "clash.mjs");
        await writeFile(clash, 'export default { name: "clash", rules: { "links/broken-internal": () => ({}) } };');
        await assert.rejects(loadPlugins([clash]), (error: Error) => error instanceof ConfigError && error.message.includes("links/broken-internal"));
        await assert.rejects(loadPlugins(["./tests/fixtures/absent.ts"]), ConfigError);
    });

    it("refuses a plugin redefining a built-in format or a source", async () => {
        const clash = path.join(directory, "format-clash.mjs");
        await writeFile(clash, 'export default { name: "format-clash", formatters: { json: () => "" }, sources: [{ id: "list", urls: async () => [] }] };');
        await assert.rejects(loadPlugins([clash]), (error: Error) => error instanceof ConfigError && error.message.includes("format json, source list"));
    });
});
