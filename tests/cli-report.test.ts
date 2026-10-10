// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { spiderlint, spiderlintWith, parsed, findingsOf, suggested } from "./fixtures/cli.ts";

describe("cli-report", () => {
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

    it("runs only the rulesets --rules names, in every group", async () => {
        const run = await spiderlint(directory, "audit", `${site.origin}/`, "--format", "json", "--fail-on", "never", "--rules", "security-headers,links");
        const rules = new Set((parsed(run) as { findings: { rule: string }[] }).findings.map((finding) => finding.rule));
        assert.ok(rules.size > 0, run.stderr);
        assert.ok(
            rules.values().every((rule) => rule.startsWith("http/") || rule.startsWith("links/")),
            [...rules].join(", "),
        );
    });

    it("refuses a browser Playwright has not installed with --no-browser-install, naming how to install it", async () => {
        const run = await spiderlintWith({ PLAYWRIGHT_BROWSERS_PATH: path.join(directory, "no-browsers-refused") }, directory, "audit", "http://127.0.0.1:9/", "--fetch", "browser", "--browser", "webkit", "--no-cache", "--no-browser-install");
        assert.equal(run.code, 2);
        assert.match(run.stderr, /browser webkit is not installed.+npx playwright install webkit/);
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
            const findings = parsed(run).findings as { rule: string; severity: string }[];
            return new Set(findings.filter((finding) => finding.rule === "html/title-length").map((finding) => finding.severity));
        };
        assert.deepEqual(await severity("--error", "html/title-length", "--info", "html/title-length"), new Set(["info"]));
        assert.deepEqual(await severity("--info", "html/title-length", "--error", "html/title-length"), new Set(["error"]));
    });

    it("counts hints apart: no grade, no failing exit, listed with --show-hints", async () => {
        const json = await suggested(directory, site.origin, "--format", "json", "--role", "development");
        const { findings, summary } = parsed(json) as { findings: { rule: string; severity: string }[]; summary: { checks: { total: number }; rating?: unknown } };
        assert.equal(json.code, 0, json.stderr);
        assert.ok(findings.length > 0 && findings.every((finding) => finding.severity === "hint"));
        assert.ok(findings.some((finding) => finding.rule === "http/server-timing"));
        assert.deepEqual([summary.checks.total, summary.rating], [0, undefined]);
        const production = await suggested(directory, site.origin, "--format", "json");
        assert.ok((parsed(production) as { findings: { rule: string }[] }).findings.every((finding) => finding.rule !== "http/server-timing"));
        const collapsed = await suggested(directory, site.origin);
        assert.match(collapsed.stdout, /^hints \(\d+ hints\)\n {10}--show-hints lists them$/m);
        assert.doesNotMatch(collapsed.stdout, /http\/digest/);
        const listed = await suggested(directory, site.origin, "--show-hints");
        assert.match(listed.stdout, /hint +0\.6 http\/digest/);
    });
});
