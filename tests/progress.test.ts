// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eta, etaText } from "../src/progress.ts";

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
        assert.equal(etaText([45, 130]), "ETA 45 s–3 min");
        assert.equal(etaText([3000, 7300]), "ETA 50 min–3 h");
        assert.equal(etaText([60, 60]), "ETA 1 min");
    });
});
