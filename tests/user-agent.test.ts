// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentHeaders, browserAgent, browserContext, chromeMajorOf, clientHints, normalizeVia, setVia, userAgent, USER_AGENT, VERSION } from "../src/agent.ts";

const CHROME = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:146.0) Gecko/20100101 Firefox/146.0";

describe("user agent", () => {
    it("keeps the bare token without an instance", () => {
        setVia("");
        assert.equal(userAgent(), USER_AGENT);
        assert.equal(userAgent(), `spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`);
    });

    it("names the instance inside the token on a web scan", () => {
        assert.equal(userAgent("spiderlint.kiota.ch"), `${USER_AGENT.slice(0, -1)}; via spiderlint.kiota.ch)`);
    });

    it("normalizes the Host header into a bare hostname", () => {
        assert.equal(normalizeVia("Spiderlint.Kiota.CH:8443"), "spiderlint.kiota.ch");
        assert.equal(normalizeVia("spiderlint.kiota.ch."), "spiderlint.kiota.ch");
        assert.equal(normalizeVia("[::1]:8080"), "::1");
        assert.equal(normalizeVia(undefined), "");
        assert.equal(normalizeVia(""), "");
        assert.equal(normalizeVia("not a host"), "");
    });

    it("remembers the instance for callers without one", () => {
        try {
            setVia("Spiderlint.Kiota.CH:443");
            assert.equal(userAgent(), `${USER_AGENT.slice(0, -1)}; via spiderlint.kiota.ch)`);
        } finally {
            setVia("");
        }
        assert.equal(userAgent(), USER_AGENT);
    });

    it("reads the Chromium major off a Chrome UA, and nothing off Firefox", () => {
        assert.equal(chromeMajorOf(CHROME), "147");
        assert.equal(chromeMajorOf(FIREFOX), undefined);
    });

    it("sends low-entropy Client Hints naming the Chromium major and the tool", () => {
        const hints = clientHints(CHROME);
        assert.equal(hints["sec-ch-ua"], `"Chromium";v="147", "Not-A.Brand";v="8", "spiderlint";v="${VERSION}"`);
        assert.equal(hints["sec-ch-ua-mobile"], "?0");
        assert.equal(hints["sec-ch-ua-platform"], `"Linux"`);
    });

    it("appends the token to a browser UA so no log reads as a real Chrome", () => {
        assert.equal(browserAgent(CHROME, "spiderlint.kiota.ch"), `${CHROME} ${USER_AGENT.slice(0, -1)}; via spiderlint.kiota.ch)`);
    });

    it("pairs a Chromium UA with matching hints, and leaves Firefox to its defaults", () => {
        const chromium = browserContext(CHROME);
        assert.equal(chromium.userAgent, `${CHROME} ${USER_AGENT}`);
        assert.equal(chromium.extraHTTPHeaders?.["sec-ch-ua"], `"Chromium";v="147", "Not-A.Brand";v="8", "spiderlint";v="${VERSION}"`);
        const firefox = browserContext(FIREFOX);
        assert.equal(firefox.userAgent, `${FIREFOX} ${USER_AGENT}`);
        assert.equal(firefox.extraHTTPHeaders, undefined);
    });

    it("heads every own-client request with the token and the hints", () => {
        const headers = agentHeaders("spiderlint.kiota.ch");
        assert.equal(headers["user-agent"], `${USER_AGENT.slice(0, -1)}; via spiderlint.kiota.ch)`);
        assert.ok(headers["sec-ch-ua"]?.includes(`"spiderlint";v="${VERSION}"`));
    });
});
