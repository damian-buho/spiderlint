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
import { layered } from "../src/config/index.ts";
import { validateSubtree } from "../src/config/schema.ts";
import { listPresets } from "../src/rules/catalog.ts";
import { catalogYaml, familyPage, ruleSection, shippedCatalog, writeRulePages } from "../src/rules/pages.ts";
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

    const none = new Set<string>();

    it("escapes a placeholder outside code spans and keeps it inside them", () => {
        const page = ruleSection(rule({ fix: "Point {host} at `{domain}`." }), "dns.md", 3, none, en);
        assert.match(page, /Point &lt;host&gt; at `<domain>`\./);
    });

    it("labels a lone fix Fix and numbers them from two fixes on", () => {
        assert.match(ruleSection(rule({ fix: "One." }), "dns.md", 3, none, en), /^\*\*Fix\*\*$/m);
        const two = ruleSection(rule({ fix: "One.", extra: ["Two."] }), "dns.md", 3, none, en);
        assert.match(two, /^\*\*Fix 1\*\*$/m);
        assert.match(two, /^\*\*Fix 2\*\*$/m);
    });

    it("heads a rule with its title, else its ID, anchored by the ID at the level asked", () => {
        assert.match(ruleSection(rule({ title: "No CAA record" }), "dns.md", 3, none, en), /^### No CAA record \{#dns\/example\/missing\}$/m);
        assert.match(ruleSection(rule({}), "axe.md", 2, none, en), /^## dns\/example\/missing \{#dns\/example\/missing\}$/m);
    });

    it("shows {got} as the localized value found and any other placeholder as <name>", () => {
        const page = ruleSection(rule({ message: "the zone has {got} servers for {field}" }), "dns.md", 3, none, en);
        assert.match(page, /^> the zone has _the value found_ servers for &lt;field&gt;$/m);
        assert.doesNotMatch(page, /\{got\}/);
        assert.match(ruleSection(rule({ message: "{got}" }), "dns.md", 3, none, translator("es")), /^> _el valor encontrado_$/m);
    });

    it("shows a static score as is and a dynamic one as its range", () => {
        assert.match(ruleSection(rule({ score: "5.4" }), "dns.md", 3, none, en), /score \[5\.4\]\(index\.md#score\)/);
        assert.match(ruleSection(rule({ score: "dynamic: 4 → 1.6, 10 → 3.0" }), "dns.md", 3, none, en), /score \[1\.6–3\.0\]/);
    });

    it("says whether a rule runs by default, which rulesets turn it on, or that an override must", () => {
        assert.match(ruleSection(rule({ rulesets: ["dns"] }), "dns.md", 3, new Set(["dns/example/missing"]), en), /^Runs by default, in the \[recommended\]\(rulesets\/recommended\.md\) ruleset\.$/m);
        assert.match(ruleSection(rule({ rulesets: ["tls-probe"] }), "dns.md", 3, none, en), /^Off by default; a group that runs \[tls-probe\]\(rulesets\/tls-probe\.md\) turns it on\.$/m);
        assert.match(ruleSection(rule({}), "dns.md", 3, none, en), /^Off by default; name it in a ruleset/m);
        assert.match(ruleSection(rule({ preset: "off", rulesets: ["dns"] }), "dns.md", 3, new Set(["dns/example/missing"]), en), /^Off in every shipped ruleset/m);
    });

    it("folds what a rule reads and its schemas away for rule authors, and drops the kind", () => {
        const page = ruleSection(rule({ facts: ["site.hosts.*.caa"], expect: { minItems: 1 } }), "dns.md", 3, none, en);
        assert.match(page, /<details>\n<summary>For rule authors<\/summary>[\s\S]*`site\.hosts\.\*\.caa`[\s\S]*"minItems": 1[\s\S]*<\/details>/);
        assert.doesNotMatch(page, /declarative/);
        assert.doesNotMatch(ruleSection(rule({}), "dns.md", 3, none, en), /<details>/);
    });

    it("labels a reference by its host", () => {
        assert.match(ruleSection(rule({ docs: "https://www.rfc-editor.org/rfc/rfc1034" }), "dns.md", 3, none, en), /^- \[rfc-editor\.org\]\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc1034\)$/m);
    });

    it("puts two-part rules first and groups longer IDs under their prefix", () => {
        const page = familyPage("dns", [rule({ id: "dns/loose" }), rule({ id: "dns/caa/missing" }), rule({ id: "dns/caa/invalid" })], none, en);
        assert.match(page, /^# dns\n\nRules: 3\n\n## dns\/loose \{#dns\/loose\}[\s\S]*^## dns\/caa$\n\n### dns\/caa\/missing[\s\S]*^### dns\/caa\/invalid/m);
    });

    it("translates the page labels into the language asked for", () => {
        assert.match(ruleSection(rule({ fix: "One." }), "dns.md", 3, none, translator("es")), /^\*\*Solución\*\*$/m);
    });

    it("writes a page per family, per ruleset and an index, every rule link landing on its anchor", () => {
        const catalog = shippedCatalog();
        const count = writeRulePages(directory, catalog, en);
        const families = new Set(catalog.map((entry) => entry.id.split("/", 1)[0]));
        assert.ok(count > families.size + 1 && count < catalog.length, `count ${count}`);
        const dns = readFileSync(path.join(directory, "dns.md"), "utf8");
        assert.match(dns, /\{#dns\/ns\/single\}/);
        const ruleset = readFileSync(path.join(directory, "rulesets", "dns-core.md"), "utf8");
        assert.match(ruleset, /^# dns:core$/m);
        const links = ruleset.matchAll(/\]\(\.\.\/([a-z-]+\.md)#([^)]+)\)/g);
        for (const [, file, anchor] of links) assert.ok(readFileSync(path.join(directory, file as string), "utf8").includes(`{#${anchor as string}}`), `${file}#${anchor}`);
        const index = readFileSync(path.join(directory, "index.md"), "utf8");
        for (const anchor of ["severity", "score", "scope", "rulesets", "configure"]) assert.ok(index.includes(`{#${anchor}}\n`), anchor);
        assert.ok(!existsSync(path.join(directory, "dns", "ns", "single.md")));
    });

    it("shows an index example that the config schema accepts and that names shipped rules and rulesets", () => {
        writeRulePages(directory, shippedCatalog(), en);
        const block = /```yaml\n([\s\S]*?)```/.exec(readFileSync(path.join(directory, "index.md"), "utf8"))?.[1] ?? "";
        const subtree = (parse(block) as { org: { spiderlint: Record<string, unknown> } }).org.spiderlint;
        validateSubtree(subtree);
        const ids = new Set(shippedCatalog().map((entry) => entry.id));
        const named = [...(subtree["exclude-rules"] as string[]), ...Object.values(subtree.override as Record<string, string[]>).flat()];
        for (const id of named) assert.ok(ids.has(id), id);
        const presets = new Set(listPresets(layered([])).map((preset) => preset.name));
        const rulesets = (subtree.groups as Record<string, { rules: string[] }>).default?.rules ?? [];
        assert.ok(rulesets.length > 0);
        for (const name of rulesets) assert.ok(presets.has(name), name);
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
