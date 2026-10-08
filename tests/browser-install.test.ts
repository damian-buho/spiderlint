// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BrowserType } from "playwright";
import { ConfigError, defaults } from "../src/config/index.ts";
import { environmentSettings } from "../src/config/environment.ts";
import { fromSubtree } from "../src/config/policy.ts";
import { validateSubtree } from "../src/config/schema.ts";
import { ensureBrowser, installArguments, installCommand, isMissingExecutable } from "../src/crawl/browser.ts";

// Playwright’s first line when the browser binary is not downloaded.
const MISSING = new Error("browserType.launch: Executable doesn't exist at /home/buho/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");

// A launcher failing with `failures` in order, counting closed launches.
function launcherOf(failures: unknown[], launches: { closed: number }): BrowserType {
    return {
        launch: async () => {
            const failure = failures.shift();
            if (failure !== undefined) throw failure;
            return {
                close: async () => {
                    launches.closed += 1;
                },
            };
        },
    } as unknown as BrowserType;
}

describe("browser install command", () => {
    it("downloads the headless shell for Chromium and the full browser otherwise", () => {
        assert.deepEqual(installArguments("chromium"), ["install", "chromium", "--only-shell"]);
        assert.deepEqual(installArguments("firefox"), ["install", "firefox"]);
        assert.equal(installCommand("chromium"), "npx playwright install chromium --only-shell");
        assert.equal(installCommand("webkit"), "npx playwright install webkit");
    });

    it("recognises only the missing-executable failure", () => {
        assert.equal(isMissingExecutable(MISSING), true);
        assert.equal(isMissingExecutable(new Error("Host system is missing dependencies to run browsers")), false);
        assert.equal(isMissingExecutable("boom"), false);
    });
});

describe("ensureBrowser", () => {
    it("launches and closes an installed browser without installing", async () => {
        const launches = { closed: 0 };
        await ensureBrowser("chromium", launcherOf([], launches), { browserInstall: true, cacheMode: "use" }, () => assert.fail("must not install"));
        assert.equal(launches.closed, 1);
    });

    it("downloads a missing browser once, then launches it", async () => {
        const launches = { closed: 0 };
        let installs = 0;
        await ensureBrowser("chromium", launcherOf([MISSING], launches), { browserInstall: true, cacheMode: "use" }, async () => {
            installs += 1;
        });
        assert.deepEqual([installs, launches.closed], [1, 1]);
    });

    it("refuses to download with browser-install off, naming the command", async () => {
        const launches = { closed: 0 };
        await assert.rejects(
            ensureBrowser("chromium", launcherOf([MISSING], launches), { browserInstall: false, cacheMode: "use" }, () => assert.fail("must not install")),
            (error: unknown) => error instanceof ConfigError && error.message.includes("npx playwright install chromium --only-shell"),
        );
        assert.equal(launches.closed, 0);
    });

    it("refuses to download --offline", async () => {
        const launches = { closed: 0 };
        await assert.rejects(
            ensureBrowser("firefox", launcherOf([MISSING], launches), { browserInstall: true, cacheMode: "offline" }, () => assert.fail("must not install")),
            /--offline cannot download it/,
        );
        assert.equal(launches.closed, 0);
    });

    it("passes any other launch failure through without installing", async () => {
        const failure = new Error("Target crashed");
        const launches = { closed: 0 };
        await assert.rejects(
            ensureBrowser("chromium", launcherOf([failure], launches), { browserInstall: true, cacheMode: "use" }, () => assert.fail("must not install")),
            (error: unknown) => error === failure,
        );
        assert.equal(launches.closed, 0);
    });

    it("fails naming the cause when the browser still does not launch", async () => {
        const launches = { closed: 0 };
        await assert.rejects(
            ensureBrowser("chromium", launcherOf([MISSING, MISSING], launches), { browserInstall: true, cacheMode: "use" }, async () => {}),
            /still does not launch/,
        );
        assert.equal(launches.closed, 0);
    });

    it("fails with the install error when the download fails", async () => {
        const failure = new ConfigError("browser chromium could not be downloaded (npx playwright install chromium --only-shell exited 1): boom");
        await assert.rejects(
            ensureBrowser("chromium", launcherOf([MISSING], { closed: 0 }), { browserInstall: true, cacheMode: "use" }, async () => {
                throw failure;
            }),
            (error: unknown) => error === failure,
        );
    });
});

describe("browser-install ladder", () => {
    it("installs by default, from the file, and never from the environment unset", () => {
        assert.equal(defaults().browserInstall, true);
        assert.deepEqual(fromSubtree({ "browser-install": false }), { browserInstall: false });
        assert.deepEqual(environmentSettings({ SPIDERLINT_BROWSER_INSTALL: "off" }), { browserInstall: false });
        assert.throws(() => environmentSettings({ SPIDERLINT_BROWSER_INSTALL: "maybe" }), /SPIDERLINT_BROWSER_INSTALL: invalid value maybe/);
    });

    it("validates browser-install as a boolean core key", () => {
        assert.deepEqual(validateSubtree({ "browser-install": false })["browser-install"], false);
        assert.throws(() => validateSubtree({ "browser-install": "yes" }), ConfigError);
    });
});
