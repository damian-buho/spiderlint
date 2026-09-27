// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, defaults } from "../src/config/index.ts";
import { PrivateAddress, refuseLiteral } from "../src/crawl/guard.ts";
import { guardedFetch, openNetwork } from "../src/crawl/network.ts";
import { audit } from "../src/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

describe("crawl address guard", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(async () => {
        await site.close();
    });

    it("refuses a private address literal only when private is refused", () => {
        assert.throws(() => refuseLiteral("http://169.254.169.254/latest", false), PrivateAddress);
        assert.throws(() => refuseLiteral("http://[::1]:8080/", false), PrivateAddress);
        assert.doesNotThrow(() => refuseLiteral("http://127.0.0.1/", true));
        assert.doesNotThrow(() => refuseLiteral("https://93.184.215.14/", false));
        assert.doesNotThrow(() => refuseLiteral("https://example.com/", false));
    });

    it("fetches nothing from a loopback seed, by literal or by name", async () => {
        const port = new URL(site.origin).port;
        const before = site.requested.length;
        for (const seed of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
            const report = await audit({ seeds: [seed], allowPrivate: false, cacheMode: "off", maxPages: 2 });
            assert.equal(report.pages.length, 0, seed);
        }
        assert.equal(site.requested.length, before);
    });

    it("still crawls the same seed when private is allowed", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], cacheMode: "off", maxPages: 1, sitemap: false, fetchResources: false });
        assert.equal(report.pages.length, 1);
    });

    it("checks every redirect hop of a guarded fetch, not only the first", async (t) => {
        const hops = t.mock.method(globalThis, "fetch", async () => new Response(undefined, { status: 302, headers: { location: "http://10.0.0.1/admin" } }));
        const network = await openNetwork({ ...defaults(), allowPrivate: false });
        try {
            await assert.rejects(guardedFetch("https://example.com/", {}), PrivateAddress);
        } finally {
            await network.close();
        }
        assert.equal(hops.mock.callCount(), 1);
        assert.equal((hops.mock.calls[0]?.arguments[1] as RequestInit).redirect, "manual");
    });

    it("refuses the browser, which no lookup guards", async () => {
        await assert.rejects(audit({ seeds: [`${site.origin}/`], fetch: "browser", allowPrivate: false, cacheMode: "off" }), (error: Error) => error instanceof ConfigError && error.message.includes("browser"));
    });
});
