// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { HtmlValidate } from "html-validate";
import { SaxesParser } from "saxes";
import { audit, type Report } from "../src/index.ts";
import { formatCheckstyle } from "../src/report/checkstyle.ts";
import { formatAgent } from "../src/report/agent.ts";
import { formatCsv } from "../src/report/csv.ts";
import { formatHuman } from "../src/report/human.ts";
import { formatHtml } from "../src/report/html.ts";
import type { Finding } from "../src/rules/types.ts";
import { parseCsv } from "./fixtures/csv.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = { posts: { match: ["/posts/**"], rules: ["seo"] }, default: { rules: ["seo", "links"] } };
const HOSTILE: Finding = { rule: "seo/title", severity: "warning", scope: "page", url: "https://a.test/", message: "title \u{1B}]8;;https://evil.test\u{7}x\n  error   forged \u{202E}evil", locations: ["1:1 title \u{1B}[2J"] };
const TRICKY: Finding = { rule: "seo/title", severity: "warning", scope: "page", url: "https://a.test/?q=<&>", message: 'says "hi", twice', locations: ["3:7 title <title>", "9:1 h1 <h1>"] };

interface Element {
    name: string;
    attributes: Record<string, string>;
    parent?: string;
}

// Every element with its attributes and parent name, or a throw on malformed XML.
function parseXml(xml: string): Element[] {
    const parser = new SaxesParser();
    const elements: Element[] = [];
    const stack: string[] = [];
    parser.on("opentag", (tag) => {
        elements.push({ name: tag.name, attributes: { ...(tag.attributes as Record<string, string>) }, parent: stack.at(-1) });
        if (!tag.isSelfClosing) stack.push(tag.name);
    });
    parser.on("closetag", (tag) => {
        if (!tag.isSelfClosing) stack.pop();
    });
    parser.write(xml).close();
    return elements;
}

describe("formatCheckstyle and formatCsv", () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
    });

    after(() => site.close());

    it("checkstyle has the Checkstyle shape: checkstyle > file[name] > error[severity,message,source]", () => {
        const elements = parseXml(formatCheckstyle(report));
        assert.equal(elements[0]?.name, "checkstyle");
        for (const element of elements.slice(1)) {
            if (element.name === "file") assert.ok(element.parent === "checkstyle" && element.attributes.name);
            else {
                assert.equal(element.name, "error");
                assert.equal(element.parent, "file");
                assert.match(element.attributes.severity ?? "", /^(error|warning|info)$/);
                assert.match(element.attributes.source ?? "", /^spiderlint\.[\w-]+\/[\w:-]+$/);
                assert.ok(element.attributes.message);
            }
        }
        assert.equal(elements.filter((element) => element.name === "error").length, report.findings.length);
    });

    it("checkstyle escapes markup and takes line and column from the first location", () => {
        const [, file, error] = parseXml(formatCheckstyle({ findings: [TRICKY] } as Report));
        assert.equal(file?.attributes.name, TRICKY.url);
        assert.deepEqual(error?.attributes, { line: "3", column: "7", severity: "warning", message: TRICKY.message, source: "spiderlint.seo/title" });
    });

    it("human, agent and checkstyle show site controls as escapes", () => {
        const hostile = { ...report, findings: [HOSTILE] };
        for (const text of [formatHuman(hostile), formatAgent(hostile), formatCheckstyle(hostile)]) {
            for (const control of ["\u{1B}", "\u{7}", "\u{202E}"]) assert.ok(!text.includes(control), JSON.stringify(control));
            assert.ok(text.includes(String.raw`title \u{1b}]8;;https://evil.test\u{7}x\u{a}  error   forged \u{202e}evil`));
        }
        assert.ok(formatHuman(hostile).includes(String.raw`at 1:1 title \u{1b}[2J`));
    });

    it("human --explain prints each finding’s fix and docs under it, and nothing without the flag", () => {
        const text = formatHuman(report, undefined, false, undefined, false, true);
        const withFix = report.findings.find((finding) => finding.severity !== "hint" && report.rules?.[finding.rule]?.fix) as Finding;
        const guide = report.rules?.[withFix.rule];
        assert.ok(text.includes(`fix  ${guide?.fix}`), withFix.rule);
        if (guide?.docs) assert.ok(text.includes(`docs ${guide.docs}`), withFix.rule);
        assert.ok(!formatHuman(report).includes(`fix  ${guide?.fix}`));
    });

    it("csv has a header and one row per finding", () => {
        const rows = parseCsv(formatCsv(report));
        assert.deepEqual(rows[0], ["severity", "score", "rule", "scope", "group", "url", "message", "occurrences", "locations"]);
        assert.equal(rows.length - 1, report.findings.length);
        assert.ok(rows.slice(1).every((row) => row.length === 9));
    });

    it("csv quotes commas, quotes and line breaks", () => {
        const [, row] = parseCsv(formatCsv({ findings: [TRICKY] } as Report));
        assert.deepEqual(row, ["warning", "5.0", "seo/title", "page", "", TRICKY.url, TRICKY.message, "", "3:7 title <title>\n9:1 h1 <h1>"]);
    });
});

describe("formatHtml", () => {
    let site: Fixture;
    let report: Report;

    before(async () => {
        site = await serveFixture();
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, excludeUrls: ["/tmp/**"] });
    });

    after(() => site.close());

    it("is a valid document naming every rule that found something", async () => {
        const html = formatHtml(report, undefined, false, "en");
        const result = await new HtmlValidate({ extends: ["html-validate:recommended"] }).validateString(html);
        assert.deepEqual(
            result.results.flatMap((file) => file.messages.map((message) => `${message.ruleId}: ${message.message}`)),
            [],
        );
        const rules = new Set(report.findings.map((finding) => finding.rule));
        for (const rule of rules) assert.ok(html.includes(`<code>${rule}</code>`), rule);
    });

    it("escapes markup and links only http(s) URLs", () => {
        const html = formatHtml({ ...report, pages: [], findings: [TRICKY, { ...TRICKY, url: "javascript:alert(1)" }] }, undefined, false, "en");
        assert.ok(html.includes("says &quot;hi&quot;, twice"));
        assert.ok(!html.includes("<&>"));
        assert.ok(!html.includes('href="javascript:'));
    });

    it("sets lang and dir and translates its own words, never a rule ID", () => {
        const html = formatHtml(report, undefined, false, "uk");
        assert.match(html, /<html lang="uk" dir="ltr">/);
        assert.ok(html.includes("Сторінки"));
        assert.ok(html.includes(`<code>${report.findings[0]?.rule}</code>`));
    });

    it("names the resource, trims same-origin URLs beside a foreign one and shows the rule’s fix", () => {
        const resource: Finding = { rule: "resources/status", severity: "warning", scope: "site", url: "https://other.test/pixel.php?id=3", message: "image answers 400; used by 2 pages", urls: [`${site.origin}/a`, `${site.origin}/b`] };
        const own: Finding = { rule: "seo/title", severity: "warning", scope: "page", group: "default", url: `${site.origin}/c`, message: "title is missing" };
        const rules = { "resources/status": { facts: ["resources"], fix: "Serve the image.", docs: "https://example.test/status" } };
        const input = { ...report, findings: [resource, own], rules };
        const html = formatHtml(input, undefined, false, "en");
        assert.ok(html.includes('href="https://other.test/pixel.php?id=3"'), "resource named");
        assert.ok(html.includes(">/a</a>") && html.includes(">/c</a>"), "same-origin URLs trimmed");
        assert.ok(html.includes("Fix: Serve the image.") && html.includes('href="https://example.test/status"'), "fix and docs");
        for (const text of [formatHuman(input), formatAgent(input)]) {
            assert.ok(text.includes("https://other.test/pixel.php?id=3"), text);
            assert.ok(text.includes("/c") && !text.includes(`${site.origin}/c`), text);
        }
    });

    it("lists one flat card per finding, the highest impact first, whole-site scope without a page list, and no group heading for default alone", () => {
        const pages = Array.from({ length: 100 }, (_unused, index) => `${site.origin}/p${index}`);
        const fold: Finding = { rule: "seo/title", severity: "warning", scope: "group", group: "default", url: `${site.origin}/p0`, message: "title is missing", occurrences: 100, coverage: 1, samples: pages.slice(0, 3) };
        const some: Finding = { rule: "seo/h1", severity: "error", scope: "group", group: "default", url: `${site.origin}/p0`, message: "h1 is missing", occurrences: 40, coverage: 0.4, samples: pages.slice(0, 2) };
        const input = { ...report, pages: report.pages, findings: [fold, some], summary: { ...report.summary, pages: 100, groups: { default: 100 } } };
        const html = formatHtml(input, undefined, false, "en");
        assert.equal(html.match(/<article class="rule-card (error|warning|info|hint)">/g)?.length, 2);
        assert.ok(
            html
                .split("<article")
                .slice(1)
                .every((part) => part.includes("</article>")),
            "no card nests another",
        );
        assert.equal(html.match(/title is missing/g)?.length, 1, "message written once");
        assert.ok(!html.includes("<table><thead><tr><th>Severity"), "no findings table");
        assert.ok(!html.includes("Group:"), "default alone has no heading");
        const wholeSite = html.split('<article class="rule-card ').find((part) => part.includes("title is missing"));
        assert.ok(wholeSite?.includes("Whole site") && !wholeSite.includes("<ul>"), "whole-site finding lists no pages");
        assert.ok(wholeSite?.includes("Impact: 500<"), "impact is score times pages");
        assert.ok(html.indexOf("title is missing") < html.indexOf("h1 is missing"), "highest impact first");
        assert.ok(wholeSite?.includes("rule-arrow"), "collapsible arrow ends the header");
        assert.ok(wholeSite?.includes('<footer class="rule-foot"><code>seo/title</code>') && !wholeSite.split("</summary>", 1)[0]?.includes("seo/title"), "rule named in the footer, not the head");
        const grouped = formatHtml({ ...input, summary: { ...input.summary, groups: { default: 60, posts: 40 } } }, undefined, false, "en");
        assert.ok(grouped.includes("Group: default · Pages: 60"));
    });

    it("lists every rule that failed nowhere once, its counts summing to the checks, and counts them for an agent", () => {
        const checked = Object.values(report.summary.checked ?? {});
        assert.equal(
            checked.reduce((sum, rule) => sum + rule.checks, 0),
            report.summary.checks.total,
        );
        assert.equal(
            checked.reduce((sum, rule) => sum + rule.failed, 0),
            report.summary.checks.failed,
        );
        const clean = Object.entries(report.summary.checked ?? {})
            .filter(([, rule]) => rule.failed === 0)
            .map(([id]) => id);
        assert.ok(clean.length > 0);
        const section = formatHtml(report, undefined, false, "en").split("<summary><h2>Passed: ", 2)[1] ?? "";
        for (const id of clean) assert.equal(section.split(`<code>${id}</code>`).length - 1, 1, id);
        assert.ok(formatHuman(report, undefined, true).includes(`✓ ${clean[0]}`));
        assert.ok(formatAgent(report).includes(`${clean.length} rules failed nowhere`));
        assert.ok(!formatAgent(report).includes(`✓`));
    });

    it("heads the passed rules with rules, pages and checks, and ends with every shipped rule that judged nothing", () => {
        const html = formatHtml(report, undefined, false, "en");
        const clean = Object.values(report.summary.checked ?? {}).filter((rule) => rule.failed === 0);
        const heading = `Passed: ${clean.length.toLocaleString("en")} rules, ${report.summary.pages.toLocaleString("en")} pages, ${clean.reduce((sum, rule) => sum + rule.checks, 0).toLocaleString("en")} checks`;
        assert.ok(html.includes(`<summary><h2>${heading}</h2>`), heading);
        const untested = report.summary.untested ?? [];
        assert.ok(untested.length > 0 && untested.every((id) => !Object.hasOwn(report.summary.checked ?? {}, id)));
        const tail = html.split('<section class="untested">', 2)[1] ?? "";
        assert.ok(tail.includes(`Skipped: ${untested.length.toLocaleString("en")} rules`));
        for (const id of untested.slice(0, 5)) assert.ok(tail.includes(`<code>${id}</code></a>`), id);
        assert.ok(!formatHtml({ ...report, summary: { ...report.summary, untested: [] } }, undefined, false, "en").includes("Skipped:"));
        const skipped = untested[0] as string;
        assert.match(tail.split(`<code>${skipped}</code></a>`, 2)[1] ?? "", /^<span class="rule-message muted">[^<]+ <small class="muted">· Presets: [a-z]/, skipped);
        assert.ok(!tail.includes("Impact: –"), "no empty impact on a skipped rule");
    });

    it("heads the report Findings (Whole site, Pages), Passed open, Statistics and Skipped closed", () => {
        const html = formatHtml(report, undefined, false, "en");
        const order = ["<h2>Findings</h2>", "<h3>Whole site</h3>", "<h3>Pages</h3>", "<details open><summary><h2>Passed: ", "<details><summary><h2>Statistics</h2>", "<details><summary><h2>Skipped: "].map((marker) => html.indexOf(marker));
        assert.ok(
            order.every((at, index) => at >= 0 && (index === 0 || at > (order[index - 1] as number))),
            String(order),
        );
    });

    it("names each labelled statistic by its translated label with the path on hover, leaves an unlabelled one out and shows a duration without a total", () => {
        const stats = { "http.size.body": { count: 2, min: 1500, median: 2000, p95: 2500, max: 2500, total: 4000 }, "html.text": { count: 2, min: 1, median: 2, p95: 3, max: 3, total: 4 }, "http.parsed.strict-transport-security.value.max-age": { count: 2, min: 300, median: 300, p95: 31_536_000, max: 31_536_000 } };
        const html = formatHtml({ ...report, summary: { ...report.summary, stats } }, undefined, false, "es");
        assert.ok(html.includes('<td><span title="http.size.body">Tamaño de la página</span></td><td>2</td><td>1,5 kB</td>'), html);
        assert.ok(!html.includes("html.text"));
        assert.ok(html.includes("max-age de HSTS") && html.includes("<td>–</td></tr>"), "no total for a configured limit");
    });
});
