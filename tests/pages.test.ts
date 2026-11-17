// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { parse } from "yaml";
import { translator } from "../src/i18n.ts";
import type { RuleExplanation } from "../src/rules/catalog.ts";
import { catalogYaml, rulePage, shippedCatalog, writeRulePages } from "../src/rules/pages.ts";
import { spiderlint } from "./fixtures/cli.ts";

const en = translator("en");

function rule(extra: Partial<RuleExplanation>): RuleExplanation {
    return { id: "dns/example/missing", severity: "off", preset: "warning", score: "1.0", scope: "site", rulesets: [], facts: [], kind: "declarative", ...extra };
}

describe("rule pages", () => {
    let directory: string;

    before(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-pages-"));
    });

    after(async () => {
        await rm(directory, { recursive: true, force: true });
    });

    it("lists every shipped rule once at org.projectfile.pages.rules.items", () => {
        const catalog = shippedCatalog();
        const items = (parse(catalogYaml(catalog, en)) as { org: { projectfile: { pages: { rules: { items: { id: string }[] } } } } }).org.projectfile.pages.rules.items;
        assert.deepEqual(
            items.map((item) => item.id),
            catalog.map((entry) => entry.id),
        );
        assert.equal(new Set(items.map((item) => item.id)).size, items.length);
    });

    it("escapes a placeholder outside code spans and keeps it inside them", () => {
        const page = rulePage(rule({ fix: "Point {host} at `{domain}`." }), en);
        assert.match(page, /Point &lt;host&gt; at `<domain>`\./);
    });

    it("titles a lone fix Fix and numbers them from two fixes on", () => {
        assert.match(rulePage(rule({ fix: "One." }), en), /^## Fix$/m);
        const two = rulePage(rule({ fix: "One.", extra: ["Two."] }), en);
        assert.match(two, /^## Fix 1$/m);
        assert.match(two, /^## Fix 2$/m);
    });

    it("links a nested rule to its ruleset page relative to its own folder", () => {
        assert.match(rulePage(rule({ id: "dns/caa/missing", rulesets: ["dns:core"] }), en), /\[dns:core\]\(\.\.\/\.\.\/rulesets\/dns-core\.md\)/);
    });

    it("translates the page labels into the language asked for", () => {
        assert.match(rulePage(rule({ fix: "One." }), translator("es")), /^## Solución$/m);
    });

    it("writes a page per rule, a page per ruleset and an index", () => {
        const catalog = shippedCatalog();
        const count = writeRulePages(directory, catalog, en);
        assert.ok(count > catalog.length + 1, `count ${count}`);
        assert.ok(existsSync(path.join(directory, `${catalog[0]?.id}.md`)));
        assert.match(readFileSync(path.join(directory, "index.md"), "utf8"), /^# Rules$/m);
        assert.match(readFileSync(path.join(directory, "rulesets", "dns-core.md"), "utf8"), /^# dns:core$/m);
    });

    it("exits 2 on markdown without --output, yaml with --output and an unknown --lang", async () => {
        for (const flags of [
            ["--format", "markdown"],
            ["--output", directory],
            ["--lang", "xx"],
            ["--format", "html"],
        ]) {
            const run = await spiderlint(directory, "rules", ...flags);
            assert.equal(run.code, 2, `${flags.join(" ")}: ${run.stderr}`);
        }
    });
});
