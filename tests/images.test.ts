// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
        assert.deepEqual(svg?.images, { format: "svg", bytes: 99 });
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
