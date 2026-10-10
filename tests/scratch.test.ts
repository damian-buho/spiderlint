// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Configuration } from "crawlee";
import { userStateDirectory } from "../src/cache/index.ts";
import { useScratchStorage } from "../src/crawl/scratch.ts";

describe("crawlee scratch storage", () => {
    const state = process.env.XDG_STATE_HOME;

    afterEach(() => {
        if (state === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = state;
        useScratchStorage();
    });

    it("keeps the global storage in memory", () => {
        useScratchStorage();
        assert.equal(Configuration.getGlobalConfig().get("persistStorage"), false);
    });

    it("roots a spill under $XDG_STATE_HOME, never the working directory", () => {
        process.env.XDG_STATE_HOME = "/state";
        useScratchStorage();
        const options = Configuration.getGlobalConfig().get("storageClientOptions") as { localDataDirectory: string };
        assert.equal(options.localDataDirectory, path.join("/state", "spiderlint", "crawlee"));
    });

    it("falls back to ~/.local/state without $XDG_STATE_HOME", () => {
        delete process.env.XDG_STATE_HOME;
        assert.match(userStateDirectory(), /[\\/]\.local[\\/]state[\\/]spiderlint$/);
    });
});
