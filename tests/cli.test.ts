// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
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
        execFile(process.execPath, ["--experimental-strip-types", CLI, ...flags], { cwd: directory, env: { ...ENVIRONMENT, XDG_CACHE_HOME: path.join(directory, "cache"), ...extra } }, (error, stdout, stderr) => {
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

    it("exits 4 when the run itself fails", async () => {
        const file = path.join(directory, "not-a-directory");
        await writeFile(file, "");
        const run = await spiderlint(directory, "lint", "--store", path.join(file, "store"));
        assert.equal(run.code, 4);
        assert.match(run.stderr, /"msg":"audit aborted"/);
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

    it("warns about a severity override naming no known rule", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--max-pages", "1", "--error", "nope/nothing", "--fail-on", "never");
        assert.equal(run.code, 0);
        const warning = run.stderr.split("\n").find((line) => line.includes("rule option names no known rule"));
        assert.ok(warning, run.stderr);
        assert.equal(JSON.parse(warning).rule, "nope/nothing");
    });

    it("shows usage for audit with no url, ignoring projectfile links", async () => {
        const project = await mkdtemp(path.join(directory, "linked-"));
        await writeFile(path.join(project, "projectfile.yaml"), ["links:", "  - type: homepage", `    url: ${site.origin}/`].join("\n"));
        const run = await spiderlint(project, "audit");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /usage: spiderlint/i);
    });

    it("colors the help only when --color forces it", async () => {
        const forced = await spiderlint(directory, "--help", "--color");
        const detected = await spiderlint(directory, "--help");
        const disabled = await spiderlint(directory, "--help", "--color", "--no-color");
        assert.ok(forced.stdout.includes("\u{1B}[1mUsage:"));
        assert.ok(!detected.stdout.includes("\u{1B}"));
        assert.ok(!disabled.stdout.includes("\u{1B}"));
    });

    it("lists every rule with the severity this configuration runs it at", async () => {
        const run = await spiderlint(directory, "rules", "--format", "json", "--error", "http/csp");
        const rules = new Map((JSON.parse(run.stdout) as { id: string; severity: string; preset: string; rulesets: string[] }[]).map((rule) => [rule.id, rule]));
        assert.equal(run.code, 0);
        assert.deepEqual(rules.get("http/csp"), { ...rules.get("http/csp"), severity: "error", preset: "warning", rulesets: ["security-headers"] });
        assert.equal(rules.get("browser/console-errors")?.severity, "off");
    });

    it("lists the shipped presets and which ones the groups use", async () => {
        const run = await spiderlint(directory, "presets", "--format", "json");
        const presets = new Map((JSON.parse(run.stdout) as { name: string; used: boolean; description: string }[]).map((preset) => [preset.name, preset]));
        assert.equal(presets.get("recommended")?.used, true);
        assert.equal(presets.get("browser")?.used, false);
        assert.ok(presets.values().every((preset) => preset.description.length > 0));
    });

    it("covers every shipped rule with the all preset", async () => {
        const every = await spiderlint(directory, "rules", "--format", "json");
        const all = await spiderlint(directory, "rules", "all", "--format", "json");
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
});
