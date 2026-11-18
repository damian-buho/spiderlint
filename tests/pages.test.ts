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
import { catalogYaml, familyPage, rulesetCatalogYaml, ruleSection, shippedCatalog, writeRulePages, writeRulesetPages } from "../src/rules/pages.ts";
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
        const page = ruleSection(rule({ fix: "Point {host} at `{domain}`." }), "rules/dns.md", 3, none, en);
        assert.match(page, /Point &lt;host&gt; at `<domain>`\./);
    });

    it("labels a lone fix Fix and numbers them from two fixes on", () => {
        assert.match(ruleSection(rule({ fix: "One." }), "rules/dns.md", 3, none, en), /^\*\*Fix\*\*$/m);
        const two = ruleSection(rule({ fix: "One.", extra: ["Two."] }), "rules/dns.md", 3, none, en);
        assert.match(two, /^\*\*Fix 1\*\*$/m);
        assert.match(two, /^\*\*Fix 2\*\*$/m);
    });

    it("heads a rule with its title, else its ID, anchored by the ID at the level asked", () => {
        assert.match(ruleSection(rule({ title: "No CAA record" }), "rules/dns.md", 3, none, en), /^### No CAA record \{#dns\/example\/missing\}$/m);
        assert.match(ruleSection(rule({}), "axe.md", 2, none, en), /^## dns\/example\/missing \{#dns\/example\/missing\}$/m);
    });

    it("shows {got} as the localized value found and any other placeholder as <name>", () => {
        const page = ruleSection(rule({ message: "the zone has {got} servers for {field}" }), "rules/dns.md", 3, none, en);
        assert.match(page, /^> the zone has _the value found_ servers for &lt;field&gt;$/m);
        assert.doesNotMatch(page, /\{got\}/);
        assert.match(ruleSection(rule({ message: "{got}" }), "rules/dns.md", 3, none, translator("es")), /^> _el valor encontrado_$/m);
    });

    it("shows a static score as is and a dynamic one as its range", () => {
        assert.match(ruleSection(rule({ score: "5.4" }), "rules/dns.md", 3, none, en), /score \[5\.4\]\(index\.md#score\)/);
        assert.match(ruleSection(rule({ score: "dynamic: 4 → 1.6, 10 → 3.0" }), "rules/dns.md", 3, none, en), /score \[1\.6–3\.0\]/);
    });

    it("says whether a rule runs by default, which rulesets turn it on, or that an override must", () => {
        assert.match(ruleSection(rule({ rulesets: ["dns"] }), "rules/dns.md", 3, new Set(["dns/example/missing"]), en), /^Runs by default, in the \[recommended\]\(\.\.\/rulesets\/recommended\.md\) ruleset\.$/m);
        assert.match(ruleSection(rule({ rulesets: ["tls-probe"] }), "rules/dns.md", 3, none, en), /^Off by default; a group that runs \[tls-probe\]\(\.\.\/rulesets\/tls-probe\.md\) turns it on\.$/m);
        assert.match(ruleSection(rule({}), "rules/dns.md", 3, none, en), /^Off by default; name it in a ruleset/m);
        assert.match(ruleSection(rule({ preset: "off", rulesets: ["dns"] }), "rules/dns.md", 3, new Set(["dns/example/missing"]), en), /^Off in every shipped ruleset/m);
    });

    it("folds what a rule reads and its schemas away for rule authors, and drops the kind", () => {
        const page = ruleSection(rule({ facts: ["site.hosts.*.caa"], expect: { minItems: 1 } }), "rules/dns.md", 3, none, en);
        assert.match(page, /<details>\n<summary>For rule authors<\/summary>[\s\S]*`site\.hosts\.\*\.caa`[\s\S]*"minItems": 1[\s\S]*<\/details>/);
        assert.doesNotMatch(page, /declarative/);
        assert.doesNotMatch(ruleSection(rule({}), "rules/dns.md", 3, none, en), /<details>/);
    });

    it("labels a reference by its host", () => {
        assert.match(ruleSection(rule({ docs: "https://www.rfc-editor.org/rfc/rfc1034" }), "rules/dns.md", 3, none, en), /^- \[rfc-editor\.org\]\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc1034\)$/m);
    });

    it("puts two-part rules first and groups longer IDs under their prefix", () => {
        const page = familyPage("dns", [rule({ id: "dns/loose" }), rule({ id: "dns/caa/missing" }), rule({ id: "dns/caa/invalid" })], none, en);
        assert.match(page, /^# dns\n\nRules: 3\n\n## dns\/loose \{#dns\/loose\}[\s\S]*^## dns\/caa$\n\n### dns\/caa\/missing[\s\S]*^### dns\/caa\/invalid/m);
    });

    it("translates the page labels into the language asked for", () => {
        assert.match(ruleSection(rule({ fix: "One." }), "rules/dns.md", 3, none, translator("es")), /^\*\*Solución\*\*$/m);
    });

    it("writes a page per family and an index, every family linked from the index", () => {
        const catalog = shippedCatalog();
        const rules = path.join(directory, "rules");
        const count = writeRulePages(rules, catalog, en);
        const families = new Set(catalog.map((entry) => entry.id.split("/", 1)[0]));
        assert.equal(count, families.size + 1);
        assert.match(readFileSync(path.join(rules, "dns.md"), "utf8"), /\{#dns\/ns\/single\}/);
        const index = readFileSync(path.join(rules, "index.md"), "utf8");
        for (const anchor of ["severity", "score", "scope", "rulesets", "configure"]) assert.ok(index.includes(`{#${anchor}}\n`), anchor);
        for (const name of families) assert.ok(index.includes(`](${name as string}.md)`), name as string);
        assert.match(index, /\]\(\.\.\/rulesets\/index\.md\)/);
        assert.ok(!existsSync(path.join(rules, "rulesets")));
        assert.ok(!existsSync(path.join(rules, "dns", "ns", "single.md")));
    });

    it("writes a page per ruleset and an index beside the rules, every rule link landing on its anchor", () => {
        const catalog = shippedCatalog();
        const rules = path.join(directory, "rules");
        const rulesets = path.join(directory, "rulesets");
        writeRulePages(rules, catalog, en);
        const presets = listPresets(layered([]));
        assert.equal(writeRulesetPages(rulesets, catalog, en), presets.length + 1);
        const ruleset = readFileSync(path.join(rulesets, "dns-core.md"), "utf8");
        assert.match(ruleset, /^# dns:core$/m);
        const links = ruleset.matchAll(/\]\(\.\.\/rules\/([a-z-]+\.md)#([^)]+)\)/g).toArray();
        assert.ok(links.length > 0);
        for (const [, file, anchor] of links) assert.ok(readFileSync(path.join(rules, file as string), "utf8").includes(`{#${anchor as string}}`), `${file}#${anchor}`);
        const index = readFileSync(path.join(rulesets, "index.md"), "utf8");
        for (const preset of presets) assert.ok(index.includes(`[${preset.name}](${preset.name.replaceAll(":", "-")}.md)`), preset.name);
    });

    it("lists every shipped ruleset once at org.projectfile.pages.rulesets.items with the rules it resolves to", () => {
        const items = (parse(rulesetCatalogYaml(en)) as { org: { projectfile: { pages: { rulesets: { items: { id: string; rules: string[] }[] } } } } }).org.projectfile.pages.rulesets.items;
        assert.deepEqual(
            items.map((item) => item.id),
            listPresets(layered([])).map((preset) => preset.name),
        );
        assert.ok(items.find((item) => item.id === "dns:core")?.rules.includes("dns/caa/missing"));
    });

    it("shows an index example that the config schema accepts and that names shipped rules and rulesets", () => {
        writeRulePages(path.join(directory, "rules"), shippedCatalog(), en);
        const block = /```yaml\n([\s\S]*?)```/.exec(readFileSync(path.join(directory, "rules", "index.md"), "utf8"))?.[1] ?? "";
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
            for (const command of ["rules", "rulesets"]) {
                const run = await spiderlint(directory, command, ...flags);
                assert.equal(run.code, 2, `${command} ${flags.join(" ")}: ${run.stderr}`);
            }
        }
    });
});
