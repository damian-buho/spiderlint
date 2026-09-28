// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

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

// RFC 4180 rows, quoted fields unescaped.
function parseCsv(csv: string): string[][] {
    const rows: string[][] = [[]];
    for (const match of csv.matchAll(/("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|$)/g)) {
        const [, raw = "", separator] = match;
        rows.at(-1)?.push(raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw);
        if (separator === "\r\n") rows.push([]);
        else if (separator === "") break;
    }
    return rows;
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
        assert.deepEqual(rows[0], ["severity", "rule", "scope", "group", "url", "message", "occurrences", "locations"]);
        assert.equal(rows.length - 1, report.findings.length);
        assert.ok(rows.slice(1).every((row) => row.length === 8));
    });

    it("csv quotes commas, quotes and line breaks", () => {
        const [, row] = parseCsv(formatCsv({ findings: [TRICKY] } as Report));
        assert.deepEqual(row, ["warning", "seo/title", "page", "", TRICKY.url, TRICKY.message, "", "3:7 title <title>\n9:1 h1 <h1>"]);
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
        assert.deepEqual(result.results.flatMap((file) => file.messages.map((message) => `${message.ruleId}: ${message.message}`)), []);
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
});
