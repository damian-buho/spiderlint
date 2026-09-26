// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ConfigError } from "../src/config/index.ts";
import { audit, type Report } from "../src/index.ts";
import { serveGallery, type Gallery } from "./fixtures/images.ts";

// Rule and path of each finding, sorted.
function found(report: Report, origin: string): string[] {
    return report.findings.map((finding) => `${finding.rule} ${finding.url.replace(origin, "")}`).toSorted((a, b) => a.localeCompare(b));
}

describe("images preset", () => {
    let gallery: Gallery;

    before(async () => {
        gallery = await serveGallery();
    });

    after(() => gallery.close());

    it("reports the heavy PNG, the oversized JPEG and the image without dimensions, and passes the rest", async () => {
        const report = await audit({ seeds: [`${gallery.origin}/`], rules: ["images"], sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(found(report, gallery.origin), ["images/dimensions /", "images/modern-format /heavy.png", "images/oversized /", "images/recompress /heavy.png", "images/weight /heavy.png"]);
        assert.match(report.findings.find((finding) => finding.rule === "images/modern-format")?.message ?? "", /^png of \d+ kB is \d+ kB as (avif|webp) \(\d+ % smaller\); used by 1 pages$/);
        assert.deepEqual(report.findings.find((finding) => finding.rule === "images/oversized")?.locations, ["/wide.jpg 400 px for width=100"]);
        assert.deepEqual(report.findings.find((finding) => finding.rule === "images/dimensions")?.locations, ["/small.webp"]);
        assert.equal(report.summary.cost.extractors.images, 4);
        const svg = report.pages[0]?.resources?.find((resource) => resource.url.endsWith("/logo.svg"));
        assert.deepEqual(svg?.images, { format: "svg", bytes: 99, encoded: { same: (svg?.images as { encoded: { same: number } }).encoded.same } });
        assert.ok((svg?.images as { encoded: { same: number } }).encoded.same < 99, "SVGO measures the optimised size");
    });

    it("reports a TrueType font, a hidden font face, an unminified script and a padded SVG, and measures one image under two URLs once", async () => {
        const metadata = mock.method(sharp.prototype, "metadata");
        try {
            const report = await audit({ seeds: [`${gallery.origin}/assets`], maxPages: 1, rules: ["images", "images:assets"], sitemap: false, robots: false, cacheMode: "off" });
            assert.deepEqual(found(report, gallery.origin), ["images/font-display /fonts.css", "images/font-format /heavy.ttf", "images/minify /bloated.js", "images/recompress /bloated.svg"]);
            assert.match(report.findings.find((finding) => finding.rule === "images/font-display")?.message ?? "", /^1 @font-face without font-display: swap, fallback or optional \(Heavy\); used by 1 pages$/);
            assert.equal(metadata.mock.callCount(), 1, "the twin JPEGs share a digest");
            const twins = report.pages[0]?.resources?.filter((resource) => /twin-[ab]\.jpg$/.test(resource.url)).map((resource) => resource.images);
            assert.equal(twins?.length, 2);
            assert.deepEqual(twins[0], twins[1]);
        } finally {
            metadata.mock.restore();
        }
    });

    it("judges the WebP an origin negotiates for a browser’s Accept, not the PNG behind it", async () => {
        const report = await audit({ seeds: [`${gallery.origin}/negotiated`], maxPages: 1, rules: ["images"], sitemap: false, robots: false, cacheMode: "off" });
        assert.deepEqual(found(report, gallery.origin), []);
        assert.equal((report.pages[0]?.resources?.find((resource) => resource.url.endsWith("/negotiated.png"))?.images as { format: string }).format, "webp");
    });

    it("takes its thresholds from org.spiderlint.images, and rejects a bad or unclaimed key", async () => {
        const config = { seeds: [`${gallery.origin}/`], rules: ["images"], sitemap: false, robots: false, cacheMode: "off" as const };
        const report = await audit({ ...config, pluginSettings: { images: { weight: 1_000_000, oversize: 10, saving: { share: 0.99 } } } });
        assert.deepEqual(found(report, gallery.origin), ["images/dimensions /"]);
        await assert.rejects(audit({ ...config, pluginSettings: { images: { weight: -1 } } }), (error: Error) => error instanceof ConfigError && error.message === "org.spiderlint/images/weight: must be >= 0");
        await assert.rejects(audit({ ...config, pluginSettings: { imagez: {} } }), (error: Error) => error instanceof ConfigError && error.message === 'org.spiderlint: unknown key "imagez"');
    });

    it("reads each image once per URL and serves its facts from the resources bucket on the next run", async () => {
        const store = await mkdtemp(path.join(tmpdir(), "spiderlint-images-"));
        try {
            const config = { seeds: [`${gallery.origin}/`], rules: ["images"], sitemap: false, robots: false };
            const first = await audit(config, { store });
            const second = await audit(config, { store });
            assert.equal(first.summary.cost.extractors.images, 4);
            assert.equal(second.summary.cost.extractors.images, undefined);
            assert.deepEqual(found(second, gallery.origin), found(first, gallery.origin));
        } finally {
            await rm(store, { recursive: true, force: true });
        }
    });

    it("leaves image bodies unread when no rule needs them", async () => {
        const report = await audit({ seeds: [`${gallery.origin}/`], rules: ["resources"], sitemap: false, robots: false, cacheMode: "off" });
        assert.equal(report.summary.cost.extractors.images, undefined);
        assert.equal(report.pages[0]?.resources?.some((resource) => resource.images !== undefined), false);
    });
});
