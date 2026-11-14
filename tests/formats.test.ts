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
import { fixHtml, formatHtml } from "../src/report/html.ts";
import { fixFor, plainFix, recordFix } from "../src/rules/fix.ts";
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
                assert.match(element.attributes.source ?? "", /^spiderlint\.[\w-]+(\/[\w:-]+)+$/);
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
        const first = plainFix(fixFor(guide?.fix ?? "", withFix))[0];
        assert.ok(text.includes(`fix  ${first}`), withFix.rule);
        if (guide?.docs) assert.ok(text.includes(`docs ${guide.docs}`), withFix.rule);
        assert.ok(!formatHuman(report).includes(`fix  ${first}`));
    });

    it("human --explain prints a Markdown fix as indented lines with code spans unwrapped", () => {
        const finding: Finding = { rule: "dns/dmarc/missing", severity: "warning", scope: "site", url: "sqlite.org", message: "no DMARC record" };
        const fix = recordFix("Add a TXT record for DMARC.", { Name: "_dmarc.{domain}", Content: "v=DMARC1; p=quarantine" }, "Then change `p=quarantine` to `p=reject`.");
        const text = formatHuman({ ...report, pages: [], findings: [finding], rules: { "dns/dmarc/missing": { facts: [], fix } } }, undefined, false, undefined, false, true);
        assert.match(text, /fix {2}Add a TXT record for DMARC\.\n {7,}- Name: _dmarc\.sqlite\.org\n {7,}- Content: v=DMARC1; p=quarantine\n {7,}Then change p=quarantine to p=reject\./u);
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

    it("renders a fix as Markdown, one record field per list item, with raw markup escaped", () => {
        const fix = recordFix("Add a TXT record for DMARC.", { Name: "_dmarc.{domain}", Content: "v=DMARC1; p=quarantine" }, "See [RFC 9989](https://www.rfc-editor.org/rfc/rfc9989) and [this](javascript:alert(1)).");
        assert.equal(fixHtml(fixFor(fix)), '<p>Add a TXT record for DMARC.</p>\n<ul>\n<li>Name: <code>_dmarc.&lt;domain&gt;</code></li>\n<li>Content: <code>v=DMARC1; p=quarantine</code></li>\n</ul>\n<p>See <a href="https://www.rfc-editor.org/rfc/rfc9989" rel="noopener noreferrer">RFC 9989</a> and this.</p>\n');
        assert.equal(fixHtml("Set <meta name=theme-color> and 1 < 2 <script>alert(1)</script>."), "<p>Set &lt;meta name=theme-color&gt; and 1 &lt; 2 &lt;script&gt;alert(1)&lt;/script&gt;.</p>\n");
    });

    it("sets lang and dir and translates its own words, never a rule ID", () => {
        const html = formatHtml(report, undefined, false, "uk");
        assert.match(html, /<html lang="uk" dir="ltr">/);
        assert.ok(html.includes("Сторінки"));
        assert.ok(html.includes(`<code>${report.findings[0]?.rule}</code>`));
    });

    it("names the resource, trims same-origin URLs beside a foreign one and shows the rule’s fix", () => {
        const resource: Finding = { rule: "resources/resource/unreachable", severity: "warning", scope: "site", url: "https://other.test/pixel.php?id=3", message: "image answers 400; used by 2 pages", urls: [`${site.origin}/a`, `${site.origin}/b`] };
        const own: Finding = { rule: "seo/title", severity: "warning", scope: "page", group: "default", url: `${site.origin}/c`, message: "title is missing" };
        const rules = { "resources/resource/unreachable": { facts: ["resources"], fix: "Serve the image.", docs: "https://example.test/status" } };
        const input = { ...report, findings: [resource, own], rules };
        const html = formatHtml(input, undefined, false, "en");
        assert.ok(html.includes("https://other.test/pixel.php?id=3"), "resource named");
        assert.ok(html.includes(">/a</a>") && html.includes(`<p><a href="${site.origin}/c" rel="nofollow noopener noreferrer">/c</a></p>`), "same-origin URLs trimmed");
        const heads = html.split('<summary class="rule-head">').slice(1);
        for (const part of heads) {
            const head = part.split("</summary>", 1)[0] ?? "";
            assert.ok(!head.includes("<a") && !head.includes("pixel.php"), "no link and no subject URL in a card head");
        }
        assert.ok(html.includes('<div class="rule-findings"><p><a href="https://other.test/pixel.php?id=3" rel="nofollow noopener noreferrer">https://other.test/pixel.php?id=3</a></p><ul>'), "subject named above its pages in the card body");
        assert.ok(html.includes("Fix: Serve the image.") && html.includes('href="https://example.test/status"'), "fix and docs");
        const human = formatHuman(input).split("\n");
        const head = human.findIndex((line) => line.includes("resources/resource/unreachable"));
        assert.deepEqual(human.slice(head, head + 3), ["  warning 5.0 resources/resource/unreachable — image answers 400; used by 2 pages", "          https://other.test/pixel.php?id=3", "            /a, /b"], "the resource under its message, its pages nested under it");
        for (const text of [formatHuman(input), formatAgent(input)]) {
            assert.ok(text.includes("https://other.test/pixel.php?id=3"), text);
            assert.ok(text.includes("/c") && !text.includes(`${site.origin}/c`), text);
        }
    });

    it("names each value measured at a resource beside it, in html and human", () => {
        const image = "https://cdn.test/hero.webp";
        const heavy: Finding = { rule: "images/weight/large", severity: "warning", scope: "site", url: image, message: "a webp image is above the weight limit", data: { [image]: { size: { fact: "http.size.body", value: 912_000 }, limit: { fact: "http.size.body", value: 200_000 } } }, urls: [`${site.origin}/a`] };
        const input = { ...report, findings: [heavy] };
        assert.ok(formatHtml(input, undefined, false, "en").includes(`>https://cdn.test/hero.webp</a><span class="data">size: 912\u{A0}kB · limit: 200\u{A0}kB</span>`), "html names size and limit");
        assert.ok(formatHuman(input, undefined, false, "en").split("\n").includes("          https://cdn.test/hero.webp  size: 912\u{A0}kB  limit: 200\u{A0}kB"), "human names size and limit");
    });

    it("lists one flat card per finding, errors first and the highest impact first within a level, whole-site scope without a page list, and no group heading for default alone", () => {
        const pages = Array.from({ length: 100 }, (_unused, index) => `${site.origin}/p${index}`);
        const fold: Finding = { rule: "seo/title", severity: "warning", scope: "group", group: "default", url: `${site.origin}/p0`, message: "title is missing", occurrences: 100, coverage: 1, samples: pages.slice(0, 3) };
        const some: Finding = { rule: "seo/h1", severity: "error", scope: "group", group: "default", url: `${site.origin}/p0`, message: "h1 is missing", occurrences: 40, coverage: 0.4, samples: pages.slice(0, 2) };
        const input = { ...report, pages: report.pages, findings: [fold, some], summary: { ...report.summary, pages: 100, groups: { default: 100 } } };
        const html = formatHtml(input, undefined, false, "en");
        assert.equal(html.match(/<article class="rule-card (error|warning|info|hint)" data-severity=/g)?.length, 2);
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
        assert.ok(!wholeSite?.includes("<ul>"), "whole-site finding lists no pages");
        assert.ok(wholeSite?.includes("Impact: 500<"), "impact is score times pages");
        assert.ok(html.indexOf("h1 is missing") < html.indexOf("title is missing"), "an error comes before a warning touching more pages");
        const byImpact = formatHtml(input, undefined, false, "en", false, false, false, "impact");
        assert.ok(byImpact.indexOf("title is missing") < byImpact.indexOf("h1 is missing"), "highest impact first when sorting by impact");
        assert.ok(byImpact.includes('id="sort-impact" checked'), "the chosen sort is the one checked");
        assert.ok(wholeSite?.includes('data-severity="1" data-impact="0" data-score="1" data-scope="0"'), "each card carries its rank by severity, impact, score and scope");
        assert.ok(html.includes('<input type="radio" name="sort" id="sort-severity" checked>') && html.includes('id="sort-impact"') && html.includes('id="sort-score"') && html.includes('id="sort-scope"'), "sort control offers severity, impact, score and scope");
        assert.match(wholeSite?.split("</summary>", 1)[0] ?? "", /Impact: 500<.*rule-message/, "impact sits in the head, before the message");
        assert.ok(!wholeSite?.split("</article>", 1)[0]?.includes("Scope:"), "a scope equal to its section is left out");
        assert.ok(wholeSite?.includes("rule-arrow"), "collapsible arrow ends the header");
        assert.ok(wholeSite?.includes('<footer class="rule-foot"><code>seo/title</code>') && !wholeSite.split("</summary>", 1)[0]?.includes("seo/title"), "rule named in the footer, not the head");
        const grouped = formatHtml({ ...input, summary: { ...input.summary, groups: { default: 60, posts: 40 } } }, undefined, false, "en");
        assert.ok(grouped.includes("Group: default · Pages: 60"));
        assert.match(
            grouped
                .split('<article class="rule-card ')
                .find((part) => part.includes("title is missing"))
                ?.split("</summary>", 1)[0] ?? "",
            /Scope: Whole site</,
            "a scope wider than its group is shown",
        );
    });

    it("opens the report with the higher score first within a level, impact breaking a tie, and no inline style attribute on a card", () => {
        const wide: Finding = { rule: "seo/wide", severity: "warning", scope: "group", group: "default", url: `${site.origin}/p0`, message: "wide is low", score: 3.8, occurrences: 100, coverage: 1 };
        const narrow: Finding = { rule: "seo/narrow", severity: "warning", scope: "group", group: "default", url: `${site.origin}/p0`, message: "narrow is high", score: 5.9, occurrences: 3, coverage: 0.03 };
        const html = formatHtml({ ...report, findings: [wide, narrow], summary: { ...report.summary, pages: 100, groups: { default: 100 } } }, undefined, false, "en");
        assert.ok(html.indexOf("narrow is high") < html.indexOf("wide is low"), "5.9 on three pages leads 3.8 on a hundred");
        const byImpact = formatHtml({ ...report, findings: [wide, narrow], summary: { ...report.summary, pages: 100, groups: { default: 100 } } }, undefined, false, "en", false, false, false, "impact");
        assert.ok(byImpact.indexOf("wide is low") < byImpact.indexOf("narrow is high"), "impact alone still puts the wider one first");
        assert.ok(!/<article[^>]* style=/.test(html), "a strict style policy would drop it");
    });

    it("lists an error above a warning on more pages in human and agent output, impact alone with sort, and the rating before the findings", () => {
        const many: Finding = { rule: "seo/title", severity: "warning", scope: "group", group: "default", url: `${site.origin}/p0`, message: "title is missing", occurrences: 100, coverage: 1, samples: [`${site.origin}/p0`] };
        const one: Finding = { rule: "seo/h1", severity: "error", scope: "page", group: "default", url: `${site.origin}/p1`, message: "h1 is missing" };
        const input = { ...report, findings: [many, one] };
        for (const [text, sorted] of [
            [formatHuman(input), formatHuman(input, undefined, false, undefined, false, false, false, "impact")],
            [formatAgent(input), formatAgent(input, undefined, false, undefined, false, false, false, "impact")],
        ] as const) {
            assert.ok(text.indexOf("h1 is missing") < text.indexOf("title is missing"), "level first");
            assert.ok(sorted.indexOf("title is missing") < sorted.indexOf("h1 is missing"), "impact alone");
            assert.ok(text.search(/rating:? +\S/i) < text.indexOf("h1 is missing"), "rating before the findings");
        }
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
        assert.ok(html.includes('<td><span title="http.size.body">Tamaño de la página</span></td><td>2</td><td>1,5\u{A0}kB</td>'), html);
        assert.ok(!html.includes("html.text"));
        assert.ok(html.includes("max-age de HSTS") && html.includes("<td>–</td></tr>"), "no total for a configured limit");
    });
});
