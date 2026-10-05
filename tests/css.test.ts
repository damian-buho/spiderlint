// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { audit, type Report } from "../src/index.ts";
import type { Facts } from "../src/facts/types.ts";
import css, { type CssFacts } from "../src/plugins/css.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

// Rule, path and locations of each finding, sorted.
function found(report: Report, origin: string): string[] {
    return report.findings.map((finding) => `${finding.rule} ${finding.url.replace(origin, "")} ${(finding.locations ?? []).join(" | ")}`).toSorted((a, b) => a.localeCompare(b));
}

// The inline CSS facts of an HTML body.
async function inline(body: string): Promise<CssFacts | undefined> {
    const page = { url: { href: "https://site.test/" }, http: { size: { body: body.length } }, html: {} } as unknown as Facts;
    return (await css.extractors?.[0]?.extract(page, body)) as CssFacts | undefined;
}

describe("css plugin", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(() => site.close());

    it("reports the broken style sheet and the inline block at their line and column, sparing vendor prefixes and hacks", async () => {
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, rules: ["css"], sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(found(report, site.origin), [
            "css/inline-unknown-property /about 23:13 <style> Unknown property `font-weigth` — font-weigth: bold",
            "css/invalid-value /broken.css 8:17 Invalid value for `font-size` property — font-size: 12",
            "css/parse-error /broken.css 9:10 Pseudo-elements like '::before' or '::after' can't be followed by selectors like 'Delim('*')' — a::before *",
            "css/unknown-property /broken.css 7:19 Unknown property `colr` — colr: #222",
        ]);
        assert.equal(report.findings.find((finding) => finding.rule === "css/unknown-property")?.message, "1 declaration in the style sheet names a property browsers do not know, so they drop it; used by 1 pages");
    });

    it("judges features against the declared browser targets", async () => {
        const report = await audit({ seeds: [`${site.origin}/about`], maxPages: 1, rules: ["css/unsupported"], pluginSettings: { css: { targets: "ie 11" } }, sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(found(report, site.origin), ["css/unsupported /broken.css 7:31 CSS Variables (Custom Properties) — IE 11"]);
        assert.match(report.findings[0]?.message ?? "", /the browser targets “ie 11” lack; used by 1 pages$/);
    });

    it("places a style attribute’s messages in the document and spares grammar gaps and guarded features", async () => {
        const facts = await inline(`<!DOCTYPE html>\n<p>x</p>\n  <div class="a" style="colour: red; word-wrap: anywhere; padding-bottom: env(safe-area-inset-bottom)">x</div>\n<style>@page { margin: 2cm; @bottom-center { content: counter(page) } }\n@supports (display: grid) { a { display: grid } }</style>`);
        assert.deepEqual(
            facts?.messages.map((message) => `${message.line}:${message.column} ${message.in} ${message.source}`),
            ["3:25 <div style> colour: red"],
        );
        assert.deepEqual(
            facts?.features.map((used) => used.feature),
            ["wordwrap", "css-env-function", "css-paged-media", "css-counters"],
        );
        assert.equal(await inline("<!DOCTYPE html><p>no CSS</p>"), undefined);
    });
});
