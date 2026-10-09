// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";
import { visit } from "../src/plugins/visit.ts";

// A page whose `goto` throws each of `failures` in turn, then loads.
function flaky(failures: string[]): { page: Page; calls: () => number } {
    let calls = 0;
    const page = {
        goto: async () => {
            const failure = failures[calls++];
            if (failure) throw new Error(`page.goto: ${failure} at https://site.test/`);
        },
        waitForLoadState: async () => {},
    } as unknown as Page;
    return { page, calls: () => calls };
}

describe("visit", () => {
    it("retries once after a transient network error", async () => {
        const { page, calls } = flaky(["net::ERR_NETWORK_CHANGED"]);
        await visit(page, "https://site.test/");
        assert.equal(calls(), 2);
    });

    it("gives up after the retry fails too", async () => {
        const { page, calls } = flaky(["net::ERR_NETWORK_CHANGED", "net::ERR_CONNECTION_RESET"]);
        await assert.rejects(visit(page, "https://site.test/"), /ERR_CONNECTION_RESET/);
        assert.equal(calls(), 2);
    });

    it("never retries a page error", async () => {
        const { page, calls } = flaky(["net::ERR_ABORTED"]);
        await assert.rejects(visit(page, "https://site.test/"), /ERR_ABORTED/);
        assert.equal(calls(), 1);
    });
});
