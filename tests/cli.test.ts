// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCsv } from "./fixtures/csv.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const { SPIDERLINT_CONFIG: _config, FORCE_COLOR: _force, ...ENVIRONMENT } = process.env;

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

// Runs the real binary outside any projectfile, with a private user cache and `extra` environment, asynchronously so the in-process fixture keeps answering.
function spiderlintWith(extra: NodeJS.ProcessEnv, directory: string, ...flags: string[]): Promise<Run> {
    return new Promise((resolve) => {
        execFile(process.execPath, ["--experimental-strip-types", CLI, ...flags], { cwd: directory, env: { ...ENVIRONMENT, SPIDERLINT_LOG_FORMAT: "json", XDG_CACHE_HOME: path.join(directory, "cache"), ...extra } }, (error, stdout, stderr) => {
            resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        });
    });
}

function spiderlint(directory: string, ...flags: string[]): Promise<Run> {
    return spiderlintWith({}, directory, ...flags);
}

// The html-validate findings of a JSON audit of `origin`.
async function findingsOf(directory: string, origin: string, ...flags: string[]): Promise<{ occurrences?: number }[]> {
    const run = await spiderlint(directory, "audit", `${origin}/`, "--format", "json", "--fail-on", "never", "--rules", "html-validate", ...flags);
    return JSON.parse(run.stdout).findings as { occurrences?: number }[];
}

// An audit of `origin` under the suggestions preset, failing on info.
function suggested(directory: string, origin: string, ...flags: string[]): Promise<Run> {
    return spiderlint(directory, "audit", `${origin}/`, "--rules", "suggestions", "--fail-on", "info", ...flags);
}

function ruleIdsOf(run: Run): string[] {
    return (JSON.parse(run.stdout) as { id: string }[]).map((rule) => rule.id);
}

describe("cli", () => {
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

    it("exits 3 naming the network error when a seed’s origin is unreachable", async () => {
        const closed = createServer();
        await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
        const { port } = closed.address() as AddressInfo;
        await new Promise((resolve) => closed.close(resolve));
        const run = await spiderlint(directory, "audit", `http://127.0.0.1:${port}/`, "--no-cache", "--no-sitemap");
        assert.equal(run.code, 3);
        const seed = run.stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { msg: string; error?: string }).find((entry) => entry.msg.startsWith("seed not crawled"));
        assert.match(seed?.error ?? "", /ECONNREFUSED/);
    });

    it("exits 2 on a seed that is not an http or https URL, before any request", async () => {
        for (const seed of ["ftp://example.com/", "file:///etc/hosts"]) {
            const run = await spiderlint(directory, "audit", seed, "--no-cache");
            assert.equal(run.code, 2);
            assert.match(run.stderr, /not an http or https URL/);
        }
    });

    it("names the command that aborted", async () => {
        const run = await spiderlint(directory, "explain-rule", "nope/nope");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /"command":"explain-rule".*"msg":"explain-rule aborted"/);
    });

    it("exits 2 naming a flag with an invalid value, without the whole usage", async () => {
        const run = await spiderlint(directory, "audit", "https://example.com/", "--format", "nope");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /--format: invalid value nope \(expected: human\|json\|sarif\|checkstyle\|csv\|html\|agent\)/);
        assert.doesNotMatch(run.stderr, /Usage:/);
    });

    it("exits 2 on --output with a format other than agent", async () => {
        const run = await spiderlint(directory, "audit", "https://example.com/", "--format", "json", "--output", directory);
        assert.equal(run.code, 2);
        assert.match(run.stderr, /--output: writes one file per rule for --format agent only, not json/);
    });

    it("formats with a plugin formatter and seeds from a plugin source, which follows links", async () => {
        const project = await mkdtemp(path.join(directory, "output-"));
        const plugin = fileURLToPath(new URL("fixtures/output-plugin.ts", import.meta.url));
        await writeFile(path.join(project, "spiderlint.yaml"), ["org:", "  spiderlint:", `    plugins: [${plugin}]`, `    sources: ["pair:${site.origin}"]`].join("\n"));
        const run = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--format", "paths", "--no-cache", "--no-sitemap", "--fail-on", "never");
        assert.equal(run.code, 0, run.stderr);
        const paths = run.stdout.trim().split("\n");
        assert.ok(paths.includes("/about") && paths.includes("/orphan") && paths.length > 2, run.stdout);
    });

    it("crawls a list:FILE source as the whole frontier, and refuses an unknown source", async () => {
        const project = await mkdtemp(path.join(directory, "list-"));
        const plugin = fileURLToPath(new URL("fixtures/output-plugin.ts", import.meta.url));
        await writeFile(path.join(project, "spiderlint.yaml"), ["org:", "  spiderlint:", `    plugins: [${plugin}]`].join("\n"));
        await writeFile(path.join(project, "urls.txt"), ["# two pages", `${site.origin}/about`, "", `${site.origin}/orphan`].join("\n"));
        const run = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--source", "list:urls.txt", "--format", "paths", "--no-cache", "--fail-on", "never");
        assert.equal(run.code, 0, run.stderr);
        assert.equal(run.stdout, "/about\n/orphan\n");
        const unknown = await spiderlint(project, "audit", "--config", "spiderlint.yaml", "--source", "nope:x", "--no-cache");
        assert.equal(unknown.code, 2);
        assert.match(unknown.stderr, /source nope: unknown \(known: list, pair\)/);
    });

    it("exits 3 on lint, show-report and export-facts of a site never crawled, creating no store", async () => {
        for (const command of [["lint"], ["show-report"], ["export-facts"]]) {
            const run = await spiderlint(directory, ...command, "https://never-crawled.example/");
            assert.equal(run.code, 3);
            assert.match(run.stderr, /nothing stored in .*run spiderlint audit or crawl first/);
        }
        await assert.rejects(stat(path.join(directory, "cache", "spiderlint", "never-crawled.example")), { code: "ENOENT" });
    });

    it("exits 4 when the run itself fails", async () => {
        const file = path.join(directory, "not-a-directory");
        await writeFile(file, "");
        const run = await spiderlint(directory, "crawl", `${site.origin}/`, "--store", path.join(file, "store"));
        assert.equal(run.code, 4);
        assert.match(run.stderr, /"msg":"crawl aborted"/);
    });

    it("keeps each site’s store in the user cache, owner-only, so lint needs only the url", async () => {
        const seed = `${site.origin}/`;
        const audited = await spiderlint(directory, "audit", seed, "--max-pages", "2", "--fail-on", "never");
        assert.equal(audited.code, 0);
        const store = path.join(directory, "cache", "spiderlint", new URL(seed).host);
        const { mode } = await stat(store);
        assert.equal(mode & 0o777, 0o700);
        const linted = await spiderlint(directory, "lint", seed, "--format", "json", "--fail-on", "never");
        assert.equal(linted.code, 0);
        assert.equal((JSON.parse(linted.stdout) as { summary: { pages: number } }).summary.pages, 2);
        const unnamed = await spiderlint(directory, "lint");
        assert.equal(unnamed.code, 2);
    });

    it("exports every stored page’s facts as CSV, and the json report carries their statistics", async () => {
        const seed = `${site.origin}/`;
        const audited = await spiderlint(directory, "audit", seed, "--rules", "sustainability", "--exclude-urls", "/tmp/**", "--format", "json", "--fail-on", "never");
        assert.equal(audited.code, 0, audited.stderr);
        const { summary } = JSON.parse(audited.stdout) as { summary: { pages: number; stats: Record<string, { median: number; total: number }> } };
        assert.ok((summary.stats["co2.grams"]?.total ?? 0) > 0 && (summary.stats["co2.grams"]?.median ?? 0) > 0, JSON.stringify(summary.stats["co2.grams"]));
        assert.equal(Object.keys(summary.stats)[0], "co2.bytes");
        const exported = await spiderlint(directory, "export-facts", seed, "--format", "csv");
        assert.equal(exported.code, 0, exported.stderr);
        const [header = [], ...rows] = parseCsv(exported.stdout.trimEnd());
        assert.equal(rows.length, summary.pages);
        assert.deepEqual(header.slice(0, 3), ["url.href", "group", "co2.bytes"]);
        assert.ok(rows.every((row) => row.length === header.length && row[0]?.startsWith(site.origin)));
        const picked = await spiderlint(directory, "export-facts", seed, "--format", "csv", "--facts", "co2.grams", "--facts", "http.timing.*");
        const [columns = []] = parseCsv(picked.stdout.trimEnd());
        assert.deepEqual(columns.slice(0, 4), ["url.href", "group", "co2.grams", "http.timing.dns"]);
        assert.ok(columns.includes("http.timing.total") && columns.slice(3).every((column) => column.startsWith("http.timing.")), columns.join(","));
        const yaml = await spiderlint(directory, "export-facts", seed, "--format", "yaml");
        assert.match(yaml.stdout, /^pages:\n {2}- url:\n/);
        const refused = await spiderlint(directory, "export-facts", seed, "--format", "json", "--facts", "co2.*");
        assert.equal(refused.code, 2);
        assert.match(refused.stderr, /--facts: picks human and csv columns only/);
        const table = await spiderlint(directory, "export-facts", seed);
        assert.equal(table.code, 0, table.stderr);
        assert.match(table.stdout, new RegExp(String.raw`^${site.origin}\npage +group +http\.status +co2\.grams +http\.size\.body +resources\.length +http\.timing\.total\n/ +default +200 `));
        assert.match(table.stdout, /\nstats +pages +min +median +p95 +max +total\nco2\.grams +\d+ /);
        const one = await spiderlint(directory, "show-facts", `${seed}about`);
        assert.equal(one.code, 0, one.stderr);
        assert.match(one.stdout, /^url\.href +http:\/\/127\.0\.0\.1:\d+\/about\n/);
        assert.match(one.stdout, /\nhttp\.status +200\n/);
    });

    it("refuses a severity override naming no known rule before any request", async () => {
        const before = site.requested.length;
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--max-pages", "1", "--error", "nope/nothing", "--fail-on", "never");
        assert.equal(run.code, 2);
        assert.equal(site.requested.length, before);
        assert.match(run.stderr, /names no known rule: nope\/nothing;/);
    });

    it("suggests the rule glob an --exclude-rules typo meant", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--rules", "all", "--exclude-rules", "lighthuse/*");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /lighthuse\/\* \(did you mean lighthouse\/\*\?\)/);
    });

    it("shows usage for audit with no url, ignoring projectfile links", async () => {
        const project = await mkdtemp(path.join(directory, "linked-"));
        await writeFile(path.join(project, "projectfile.yaml"), ["links:", "  - type: homepage", `    url: ${site.origin}/`].join("\n"));
        const run = await spiderlint(project, "audit");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /usage: spiderlint/i);
    });

    it("audits every declared site into its own store, or the ones --site names", async () => {
        const project = await mkdtemp(path.join(directory, "sites-"));
        const other = site.origin.replace("127.0.0.1", "localhost");
        const document = ["org:", "  spiderlint:", "    max-pages: 1", "    sites:", "      static:", `        targets: [${site.origin}/]`, "      preview:", `        targets: [${other}/]`, "        max-pages: 2"].join("\n");
        await writeFile(path.join(project, "projectfile.yaml"), document);
        const stores = path.join(project, "cache", "spiderlint");
        const all = await spiderlint(project, "audit", "--config", "projectfile.yaml", "--fail-on", "never");
        assert.equal(all.code, 0, all.stderr);
        assert.match(all.stdout, /^static$/m);
        assert.match(all.stdout, /^preview$/m);
        await stat(path.join(stores, new URL(site.origin).host));
        await stat(path.join(stores, new URL(other).host));
        const one = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--site", "preview", "--format", "json", "--fail-on", "never");
        assert.equal(one.code, 0, one.stderr);
        assert.equal((JSON.parse(one.stdout) as { summary: { pages: number } }).summary.pages, 2);
        const unknown = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--site", "nope");
        assert.equal(unknown.code, 2);
        assert.match(unknown.stderr, /unknown site nope \(declared: (static, preview|preview, static)\)/);
        const machine = await spiderlint(project, "lint", "--config", "projectfile.yaml", "--format", "json");
        assert.equal(machine.code, 2);
    });

    it("rejects an unknown flag in one line, with no stack trace", async () => {
        const run = await spiderlint(directory, "lint", "https://a.test/", "--log-levl", "error");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /^spiderlint: unknown option '--log-levl' \(did you mean --log-level\?\) \(see spiderlint --help\)\n$/);
    });

    it("keeps stderr empty at --log-level silent", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--no-cache", "--log-level", "silent");
        assert.equal(run.stderr, "");
    });

    it("rejects an unknown --log-level", async () => {
        const run = await spiderlint(directory, "lint", "https://a.test/", "--log-level", "loud");
        assert.equal(run.code, 2);
        assert.equal(run.stderr, "spiderlint: --log-level: unknown level loud (see spiderlint --help)\n");
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
        assert.match(main.stdout, /^spiderlint \S+\n.+\nhttps:\/\/dbuho\.me\/project\/spiderlint\/\n/);
        assert.match(main.stdout, /\nCheck a site:\n {2}audit \[domain…\]/);
        assert.match(main.stdout, /\nExit codes:\n/);
        assert.doesNotMatch(main.stdout, /--max-pages|Examples:/);
        const own = await spiderlint(directory, "audit", "--help");
        const named = await spiderlint(directory, "help", "audit");
        assert.equal(own.stdout, named.stdout);
        assert.ok(["Crawl:", "Rules:", "Report:", "Store:", "Examples:"].every((heading) => own.stdout.includes(`\n${heading}\n`)), own.stdout);
        assert.ok(own.stdout.includes(path.join(directory, "cache", "spiderlint", "<host>")), own.stdout);
        const listing = await spiderlint(directory, "list-presets", "--help");
        assert.doesNotMatch(listing.stdout, /Crawl:|--store/);
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
        assert.deepEqual([...named].filter((name) => !code.includes(`.${name}`)), []);
    });

    it("lists every rule with the severity this configuration runs it at", async () => {
        const run = await spiderlint(directory, "list-rules", "--format", "json", "--error", "http/csp");
        const rules = new Map((JSON.parse(run.stdout) as { id: string; severity: string; preset: string; rulesets: string[] }[]).map((rule) => [rule.id, rule]));
        assert.equal(run.code, 0);
        assert.deepEqual(rules.get("http/csp"), { ...rules.get("http/csp"), severity: "error", preset: "warning", rulesets: ["security-headers"] });
        assert.equal(rules.get("browser/console-errors")?.severity, "off");
    });

    it("lists the shipped presets and which ones the groups use", async () => {
        const run = await spiderlint(directory, "list-presets", "--format", "json");
        const presets = new Map((JSON.parse(run.stdout) as { name: string; used: boolean; description: string }[]).map((preset) => [preset.name, preset]));
        assert.equal(presets.get("recommended")?.used, true);
        assert.equal(presets.get("browser")?.used, false);
        assert.ok(presets.values().every((preset) => preset.description.length > 0));
    });

    it("explains a declarative, a built-in and a plugin rule, and refuses an unknown one", async () => {
        const declarative = await spiderlint(directory, "explain-rule", "html/theme-color-schemes", "--format", "json");
        assert.equal(declarative.code, 0, declarative.stderr);
        const rule = JSON.parse(declarative.stdout) as { kind: string; facts: string[]; expect: object; fix: string; docs: string };
        assert.deepEqual([rule.kind, rule.facts], ["declarative", ["html.metas"]]);
        assert.ok(rule.expect && rule.fix && rule.docs, declarative.stdout);
        const builtin = await spiderlint(directory, "explain-rule", "links/redirected-internal", "--no-color");
        assert.match(builtin.stdout, /^kind\s+built-in$/m);
        assert.match(builtin.stdout, /^docs\s+https:/m);
        const plugin = await spiderlint(directory, "explain-rule", "axe/color-contrast", "--format", "json");
        assert.deepEqual((JSON.parse(plugin.stdout) as { rulesets: string[] }).rulesets, ["axe", "axe:wcag"]);
        const unknown = await spiderlint(directory, "explain-rule", "nope/missing");
        const bare = await spiderlint(directory, "explain-rule");
        assert.deepEqual([unknown.code, bare.code], [2, 2]);
    });

    it("covers every shipped rule with the all preset", async () => {
        const every = await spiderlint(directory, "list-rules", "--format", "json");
        const all = await spiderlint(directory, "list-rules", "all", "--format", "json");
        assert.deepEqual(ruleIdsOf(all), ruleIdsOf(every));
    });

    it("runs only the rulesets --rules names, in every group", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--format", "json", "--fail-on", "never", "--rules", "security-headers,links");
        const rules = new Set((JSON.parse(run.stdout) as { findings: { rule: string }[] }).findings.map((finding) => finding.rule));
        assert.ok(rules.size > 0, run.stderr);
        assert.ok(rules.values().every((rule) => rule.startsWith("http/") || rule.startsWith("links/")), [...rules].join(", "));
    });

    it("refuses a browser Playwright has not installed, naming how to install it", async () => {
        const run = await spiderlintWith({ PLAYWRIGHT_BROWSERS_PATH: path.join(directory, "no-browsers") }, directory, "audit", "http://127.0.0.1:9/", "--fetch", "browser", "--browser", "webkit", "--no-cache");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /browser webkit is not installed .+npx playwright install webkit/);
    });

    it("unfolds with --unfold, one finding per page", async () => {
        const folded = await findingsOf(directory, site.origin);
        const unfolded = await findingsOf(directory, site.origin, "--unfold");
        assert.ok(folded.some((finding) => finding.occurrences !== undefined));
        assert.ok(unfolded.every((finding) => finding.occurrences === undefined) && unfolded.length > folded.length);
    });

    it("applies severity flags in argv order", async () => {
        const severity = async (...flags: string[]) => {
            const run = await spiderlint(directory, "audit", `${site.origin}/`, "--format", "json", "--fail-on", "never", ...flags);
            const findings = JSON.parse(run.stdout).findings as { rule: string; severity: string }[];
            return new Set(findings.filter((finding) => finding.rule === "html/title-length").map((finding) => finding.severity));
        };
        assert.deepEqual(await severity("--error", "html/title-length", "--info", "html/title-length"), new Set(["info"]));
        assert.deepEqual(await severity("--info", "html/title-length", "--error", "html/title-length"), new Set(["error"]));
    });

    it("counts hints apart: no grade, no failing exit, listed with --show-hints", async () => {
        const json = await suggested(directory, site.origin, "--format", "json", "--role", "development");
        const { findings, summary } = JSON.parse(json.stdout) as { findings: { rule: string; severity: string }[]; summary: { checks: { total: number }; rating?: unknown } };
        assert.equal(json.code, 0, json.stderr);
        assert.ok(findings.length > 0 && findings.every((finding) => finding.severity === "hint"));
        assert.ok(findings.some((finding) => finding.rule === "http/server-timing"));
        assert.deepEqual([summary.checks.total, summary.rating], [0, undefined]);
        const production = await suggested(directory, site.origin, "--format", "json");
        assert.ok((JSON.parse(production.stdout) as { findings: { rule: string }[] }).findings.every((finding) => finding.rule !== "http/server-timing"));
        const collapsed = await suggested(directory, site.origin);
        assert.match(collapsed.stdout, /^hints \(\d+ hints\)\n {10}--show-hints lists them$/m);
        assert.doesNotMatch(collapsed.stdout, /http\/digest/);
        const listed = await suggested(directory, site.origin, "--show-hints");
        assert.match(listed.stdout, /hint +http\/digest/);
    });
});
