// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { logColor, oneLine } from "../src/logger.ts";

describe("terminal log line", () => {
    it("keeps message, url and error, and hides the other fields", () => {
        logColor(false);
        assert.equal(oneLine({ level: 40, msg: "sitemap read", url: "/sitemap.xml", status: 200, error: "is text/html, not a sitemap" }, "msg"), "sitemap read /sitemap.xml is text/html, not a sitemap");
    });

    it("shows the fields of a line with no url or error", () => {
        logColor(false);
        assert.equal(oneLine({ level: 30, msg: "sitemap parsed", files: 3, seeds: ["/"] }, "msg"), 'sitemap parsed files=3 seeds=["/"]');
    });

    it("drops the fields its message already says", () => {
        logColor(false);
        assert.equal(oneLine({ level: 30, msg: "109 external links probed, 13 skipped", links: 109, skipped: 13, failed: 2 }, "msg"), "109 external links probed, 13 skipped failed=2");
        assert.equal(oneLine({ level: 40, msg: "dns, mail skipped", extractors: ["dns", "mail"] }, "msg"), "dns, mail skipped");
    });

    it("colors urls, in the url field and inside the message", () => {
        logColor(true);
        assert.equal(oneLine({ msg: "failed https://a.test/x", url: "/y" }, "msg"), "failed \u{1B}[36mhttps://a.test/x\u{1B}[39m \u{1B}[36m/y\u{1B}[39m");
        logColor(undefined);
    });
});
