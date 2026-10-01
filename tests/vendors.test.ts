// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { defaults } from "../src/config/index.ts";
import { vendorPath, vendorPaths } from "../src/facts/vendors.ts";
import { audit, type Report } from "../src/index.ts";
import { formatHuman } from "../src/report/human.ts";
import { explainRule } from "../src/rules/catalog.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const RULES = ["html-validate", "htmlhint:extra", "links", "resources", "vendor"];
const PROTECTION = "/cdn-cgi/l/email-protection";
const DEFECTS = ["html-validate/no-conditional-comment", "htmlhint/meta-description-require"];

describe("vendor paths", () => {
    let site: Fixture;
    let on: Report;
    let off: Report;

    before(async () => {
        site = await serveFixture();
        const options = { seeds: [`${site.origin}/contact`], sitemap: false, rules: RULES, fold: false as const, cacheMode: "off" as const };
        on = await audit(options);
        off = await audit({ ...options, vendorPaths: false });
    });

    after(() => site.close());

    const at = (report: Report, path: string) => report.findings.filter((finding) => new URL(finding.url).pathname === path).map((finding) => finding.rule);

    it("ships entries each naming a vendor, a glob, a kind and its docs", () => {
        for (const entry of vendorPaths()) assert.ok(entry.vendor && entry.match.startsWith("/") && entry.kind.length > 0 && entry.kind.every((kind) => kind === "page" || kind === "resource") && URL.canParse(entry.docs), entry.match);
        assert.equal(vendorPath("https://example.com/cdn-cgi/image/width=80/a.png", "resource"), undefined, "an image transformation stays the site’s");
        assert.equal(vendorPath("https://example.com/cdn-cgi/l/email-protection#ab", "page")?.vendor, "Cloudflare");
    });

    it("keeps the email protection page out of the crawl, its link out of links/broken, and records the link’s vendor", () => {
        assert.ok(on.pages.every((page) => page.url.pathname !== PROTECTION));
        assert.deepEqual(at(on, PROTECTION), []);
        assert.ok(on.findings.every((finding) => !finding.rule.startsWith("links/broken")));
        const contact = on.pages.find((page) => page.url.pathname === "/contact");
        assert.deepEqual(Object.values(contact?.html?.links.vendor ?? {}), ["Cloudflare"]);
    });

    it("reports the email obfuscation once, with the dashboard switch as its fix", () => {
        const found = on.findings.filter((finding) => finding.rule === "vendor/cloudflare-email-obfuscation");
        assert.equal(found.length, 1);
        assert.equal(found[0]?.severity, "info");
        assert.match(explainRule(defaults(), "vendor/cloudflare-email-obfuscation").fix ?? "", /Email Address Obfuscation.*Security › Settings/);
    });

    it("judges the decode script and lists its findings under the vendor", () => {
        const decode = on.findings.find((finding) => finding.rule === "resources/status");
        assert.equal(decode?.vendor, "Cloudflare");
        assert.match(formatHuman(on), /^Cloudflare \(vendor\)\n {2}error {3}resources\/status/m);
    });

    it("lints the page as the site’s own with vendor-paths false", () => {
        for (const rule of DEFECTS) assert.ok(at(off, PROTECTION).includes(rule), rule);
        assert.ok(off.findings.every((finding) => finding.rule !== "vendor/cloudflare-email-obfuscation" && !finding.vendor));
    });
});
