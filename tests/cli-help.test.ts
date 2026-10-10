// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { spiderlint, parsed, ruleIdsOf } from "./fixtures/cli.ts";

describe("cli-help", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-cli-"));
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("colors the help only when --color forces it", async () => {
        const forced = await spiderlint(directory, "--help", "--color");
        const detected = await spiderlint(directory, "--help");
        const disabled = await spiderlint(directory, "--help", "--color", "--no-color");
        assert.ok(forced.stdout.includes("\u{1B}[1mUsage:"));
        assert.ok(!detected.stdout.includes("\u{1B}"));
        assert.ok(!disabled.stdout.includes("\u{1B}"));
    });

    it("shows grouped commands, tool-wide options and exit codes on the main screen, one command’s sections on its own", async () => {
        const main = await spiderlint(directory, "--help");
        assert.match(main.stdout, /^spiderlint\n.+\nhttps:\/\/dbuho\.me\/project\/spiderlint\/\n/);
        assert.match(main.stdout, /\nCheck a site:\n {2}audit \[domain…\]/);
        assert.match(main.stdout, /\nExit codes:\n/);
        assert.doesNotMatch(main.stdout, /--max-pages|Examples:/);
        const own = await spiderlint(directory, "audit", "--help");
        const named = await spiderlint(directory, "help", "audit");
        assert.equal(own.stdout, named.stdout);
        assert.ok(
            ["Crawl:", "Rules:", "Report:", "Store:", "Examples:"].every((heading) => own.stdout.includes(`\n${heading}\n`)),
            own.stdout,
        );
        assert.ok(own.stdout.includes(path.join(directory, "cache", "spiderlint", "<host>")), own.stdout);
        const listing = await spiderlint(directory, "list-presets", "--help");
        assert.doesNotMatch(listing.stdout, /Crawl:|--store/);
    });

    it("never wraps an item description onto a line of one or two words at 80 columns", async () => {
        const main = await spiderlint(directory, "--help");
        const commands = main.stdout.match(/^ {2}[a-z]+(?:-[a-z]+)* /gm)?.map((line) => line.trim()) ?? [];
        assert.ok(commands.length > 10, commands.join(", "));
        const screens = await Promise.all([[], ...commands.filter((command) => command !== "help").map((command) => [command])].map((command) => spiderlint(directory, ...command, "--help")));
        const orphans = screens.flatMap((screen) => screen.stdout.split("\n").filter((line) => /^ {20,}[^\s(]/.test(line) && line.trim().split(/\s+/).length < 3 && line.trim().length < 40));
        assert.deepEqual(orphans, []);
    });

    it("points an old command name at the verbs that replaced it", async () => {
        const run = await spiderlint(directory, "facts");
        assert.equal(run.code, 2);
        assert.equal(run.stderr, "spiderlint: unknown command 'facts' (did you mean show-facts or export-facts?) (see spiderlint --help)\n");
    });

    it("reads every SPIDERLINT_ variable the help names", async () => {
        const screens = await Promise.all(["--help", "audit", "show-facts", "list-rules"].map((command) => spiderlint(directory, ...(command === "--help" ? [command] : [command, "--help"]))));
        const named = new Set(screens.flatMap((screen) => screen.stdout.match(/SPIDERLINT_[A-Z_]+/g) ?? []));
        const sources = fileURLToPath(new URL("../src/", import.meta.url));
        const entries = await readdir(sources, { recursive: true });
        const contents = await Promise.all(entries.filter((file) => file.endsWith(".ts")).map((file) => readFile(path.join(sources, file), "utf8")));
        const code = contents.join("\n");
        assert.ok(named.size > 20, [...named].join(", "));
        assert.deepEqual(
            [...named].filter((name) => !code.includes(`.${name}`)),
            [],
        );
    });

    it("lists every rule with the severity this configuration runs it at", async () => {
        const run = await spiderlint(directory, "list-rules", "--format", "json", "--error", "http/csp");
        const rules = new Map((parsed(run) as { id: string; severity: string; preset: string; rulesets: string[] }[]).map((rule) => [rule.id, rule]));
        assert.equal(run.code, 0);
        assert.deepEqual(rules.get("http/csp"), { ...rules.get("http/csp"), severity: "error", preset: "warning", rulesets: ["security-headers"] });
        assert.equal(rules.get("browser/console-errors")?.severity, "off");
    });

    it("lists the shipped presets and which ones the groups use", async () => {
        const run = await spiderlint(directory, "list-presets", "--format", "json");
        const presets = new Map((parsed(run) as { name: string; used: boolean; description: string }[]).map((preset) => [preset.name, preset]));
        assert.equal(presets.get("recommended")?.used, true);
        assert.equal(presets.get("browser")?.used, false);
        assert.ok(presets.values().every((preset) => preset.description.length > 0));
    });

    it("explains a declarative, a built-in and a plugin rule, and refuses an unknown one", async () => {
        const declarative = await spiderlint(directory, "explain-rule", "html/theme-color-schemes", "--format", "json");
        assert.equal(declarative.code, 0, declarative.stderr);
        const rule = parsed(declarative) as { kind: string; facts: string[]; expect: object; fix: string; docs: string };
        assert.deepEqual([rule.kind, rule.facts], ["declarative", ["html.metas"]]);
        assert.ok(rule.expect && rule.fix && rule.docs, declarative.stdout);
        const builtin = await spiderlint(directory, "explain-rule", "links/redirected-internal", "--no-color");
        assert.match(builtin.stdout, /^kind\s+built-in$/m);
        assert.match(builtin.stdout, /^docs\s+https:/m);
        const plugin = await spiderlint(directory, "explain-rule", "axe/color-contrast", "--format", "json");
        assert.deepEqual((parsed(plugin) as { rulesets: string[] }).rulesets, ["axe", "axe:wcag"]);
        const unknown = await spiderlint(directory, "explain-rule", "nope/missing");
        const bare = await spiderlint(directory, "explain-rule");
        assert.deepEqual([unknown.code, bare.code], [2, 2]);
    });

    it("covers every shipped rule with the all preset", async () => {
        const every = await spiderlint(directory, "list-rules", "--format", "json");
        const all = await spiderlint(directory, "list-rules", "all", "--format", "json");
        assert.deepEqual(ruleIdsOf(all), ruleIdsOf(every));
    });
});
