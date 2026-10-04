// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eta, etaSpan, etaText, onProgress, PHASES, progressCount, progressDone, progressEnd, progressPhase, type Progress } from "../src/progress.ts";

describe("progress ETA", () => {
    it("stays silent until enough pages are sampled or nothing is left", () => {
        assert.equal(eta([1, 1], 10), undefined);
        assert.equal(eta([1, 1, 1], 0), undefined);
    });

    it("collapses to a point when every gap is equal", () => {
        assert.deepEqual(eta([2, 2, 2], 30), [60, 60]);
    });

    it("brackets the mean and narrows as the window fills", () => {
        const few = eta([1, 3, 2], 100)!;
        const many = eta(Array.from({ length: 16 }, () => [1, 3, 2]).flat(), 100)!;
        assert.ok(few[0] < 200 && few[1] > 200);
        assert.ok(many[1] - many[0] < few[1] - few[0]);
        assert.ok(few[0] >= 0);
    });

    it("prints one unit when both ends share it", () => {
        assert.equal(etaText(undefined), "");
        assert.equal(etaText([12.4, 40.2]), "ETA 12–41 s");
        assert.equal(etaText([150, 250]), "ETA 2–5 min");
        assert.equal(etaText([45, 130]), "ETA under 3 min");
        assert.equal(etaText([3000, 7300]), "ETA under 3 h");
        assert.equal(etaText([60, 60]), "ETA 1 min");
    });

    it("rounds to whole numbers in the unit the high end reaches, switching to minutes past 60 s", () => {
        assert.deepEqual(etaSpan([0, 61.369]), { low: 0, high: 2, unit: "minute" });
        assert.deepEqual(etaSpan([12.4, 40.2]), { low: 12, high: 41, unit: "second" });
        assert.deepEqual(etaSpan([150, 250]), { low: 2, high: 5, unit: "minute" });
        assert.deepEqual(etaSpan([7300, 9000]), { low: 2, high: 3, unit: "hour" });
        for (const range of [[0.2, 59.1], [3.3, 3599.9], [1, 90_000]] as [number, number][]) {
            const { low, high } = etaSpan(range);
            assert.ok(Number.isSafeInteger(low) && Number.isSafeInteger(high), String(range));
        }
    });
});

describe("progress listener", () => {
    it("hears every finished page with the ETA once enough are sampled", () => {
        const heard: Progress[] = [];
        onProgress((progress) => {
            heard.push(progress);
        });
        for (const done of [1, 2, 3, 4]) progressDone(done);
        assert.deepEqual(heard.map((progress) => progress.done), [1, 2, 3, 4]);
        assert.equal(heard.at(-1)?.total, 4);
        assert.equal(heard[0]?.eta, undefined);
    });
});

describe("progress phases", () => {
    it("runs the crawl, then the work on its pages, then the rules", () => {
        assert.deepEqual(PHASES, ["crawl", "resources", "probes", "site", "lint"]);
    });

    it("tells the listener each phase as it starts, with the count inside it", () => {
        const heard: Progress[] = [];
        onProgress((progress) => {
            heard.push(progress);
        });
        progressDone(10);
        for (const phase of PHASES.slice(1)) progressPhase(phase, phase === "lint" ? undefined : 2);
        progressPhase("resources", 2);
        progressCount(1);
        progressCount(2);
        progressEnd();
        assert.deepEqual(heard.map((progress) => progress.phase), ["crawl", "resources", "probes", "site", "lint", "resources", "resources"]);
        assert.deepEqual(heard.at(-1)?.step, { done: 2, total: 2 });
        assert.equal(heard[4]?.step, undefined);
        assert.equal(heard.at(-1)?.eta, undefined);
    });
});
