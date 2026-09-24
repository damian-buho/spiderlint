// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Runs the real binary outside any projectfile, asynchronously so the in-process fixture keeps answering.
function spiderlint(directory: string, ...flags: string[]): Promise<Run> {
    return new Promise((resolve) => {
        execFile(process.execPath, ["--experimental-strip-types", CLI, ...flags], { cwd: directory, env: ENVIRONMENT }, (error, stdout, stderr) => {
            resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        });
    });
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
