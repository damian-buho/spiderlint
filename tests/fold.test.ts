// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fold } from "../src/fold/index.ts";
import { cell, type RuleRun } from "../src/rules/run.ts";
import type { Finding } from "../src/rules/types.ts";

const RULE = "css/inline-unsupported";
const HAS = ["74:9 <style> :has() CSS relational pseudo-class — Firefox 115–120"];

// One page’s finding of the shared `<style>` block, at `locations`.
function inline(group: string, path: string, locations = HAS): Finding {
    const url = `https://site.test${path}`;
    return { rule: RULE, severity: "info", scope: "page", group, url, message: "inline CSS uses features the browser targets “defaults” lack", text: "inline CSS uses features the browser targets “{query}” lack", variables: { query: "defaults" }, data: { [url]: { features: 1 } }, locations };
}

// A rule run over `findings`, each group judging `applicable` pages.
function run(findings: Finding[], applicable: Record<string, number>): RuleRun {
    return { findings, applicable: new Map(Object.entries(applicable).map(([group, pages]) => [cell(group, RULE), pages])), checks: { total: 0, failed: 0, errored: 0, cost: 0 }, perRule: new Map() };
}

const FOLD = { threshold: 0.8, min: 3 };

describe("fold across groups", () => {
    it("reports one inline block two groups share once, naming both groups and every page", () => {
        const findings = [inline("posts", "/posts/1"), inline("posts", "/posts/2"), inline("posts", "/posts/3"), inline("cv", "/cv/")];
        const [merged, ...rest] = fold(run(findings, { posts: 3, cv: 1 }), FOLD);
        assert.deepEqual(rest, []);
        assert.equal(merged?.scope, "site");
        assert.deepEqual(merged?.groups, ["posts", "cv"]);
        assert.equal(merged?.occurrences, 4);
        assert.equal(merged?.coverage, 1);
        assert.deepEqual(merged?.samples, ["https://site.test/cv/", "https://site.test/posts/1", "https://site.test/posts/2"]);
        assert.deepEqual(merged?.sampleLocations?.["https://site.test/cv/"], HAS);
    });

    it("keeps the finding under the one group that has the block", () => {
        const found = fold(run([inline("posts", "/posts/1"), inline("posts", "/posts/2"), inline("posts", "/posts/3")], { posts: 3, cv: 1 }), FOLD);
        assert.deepEqual(
            found.map((finding) => [finding.scope, finding.group, finding.occurrences]),
            [["group", "posts", 3]],
        );
    });

    it("keeps one finding per group when the groups differ in the result, and merges nothing unfolded", () => {
        const elsewhere = ["12:3 <style> :has() CSS relational pseudo-class — Firefox 115–120"];
        const findings = [inline("posts", "/posts/1"), inline("posts", "/posts/2"), inline("posts", "/posts/3"), inline("cv", "/cv/", elsewhere)];
        assert.deepEqual(
            fold(run(findings, { posts: 3, cv: 1 }), FOLD).map((finding) => [finding.scope, finding.group]),
            [
                ["group", "posts"],
                ["page", "cv"],
            ],
        );
        const shared = [...findings.slice(0, 3), inline("cv", "/cv/")];
        assert.equal(fold(run(shared, { posts: 3, cv: 1 }), false).length, 4);
    });
});
