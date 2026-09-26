// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SaxesParser } from "saxes";
import { audit, type Report } from "../src/index.ts";
import { formatCheckstyle } from "../src/report/checkstyle.ts";
import { formatCsv } from "../src/report/csv.ts";
import type { Finding } from "../src/rules/types.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const GROUPS = { posts: { match: ["/posts/**"], rules: ["seo"] }, default: { rules: ["seo", "links"] } };
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
        report = await audit({ seeds: [`${site.origin}/`], groups: GROUPS, exclude: ["/tmp/**"] });
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
