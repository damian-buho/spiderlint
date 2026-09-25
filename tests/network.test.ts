// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, proxyOf } from "../src/config/index.ts";
import { validateSubtree } from "../src/config/schema.ts";
import { openNetwork, pace } from "../src/crawl/network.ts";
import { audit } from "../src/index.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { serveHttpProxy, serveSocksProxy } from "./fixtures/proxies.ts";

const EXCLUDE = ["/tmp/**"];

describe("network", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(async () => {
        await site.close();
    });

    it("accepts http, https and socks proxies and refuses any other scheme", () => {
        assert.equal(proxyOf("--proxy", "socks5h://127.0.0.1:9050"), "socks5h://127.0.0.1:9050");
        assert.equal(proxyOf("--proxy", ""), "");
        assert.throws(() => proxyOf("--proxy", "ftp://127.0.0.1:21"), ConfigError);
        assert.throws(() => validateSubtree({ rate: -1 }), ConfigError);
    });

    it("spaces requests to the configured rate", async () => {
        const network = await openNetwork({ rate: 600, proxy: "", allowPrivate: true });
        const started = performance.now();
        for (let request = 0; request < 4; request += 1) await pace();
        await network.close();
        assert.ok(performance.now() - started >= 290, "four requests at 600/min take three 100 ms gaps");
    });

    it("stops pacing once the network closes", async () => {
        const network = await openNetwork({ rate: 1, proxy: "", allowPrivate: true });
        await network.close();
        const started = performance.now();
        await pace();
        await pace();
        assert.ok(performance.now() - started < 50);
    });

    it("refuses a proxy where the address guard must hold", async () => {
        await assert.rejects(openNetwork({ rate: 0, proxy: "http://127.0.0.1:1", allowPrivate: false }), ConfigError);
    });

    for (const [kind, serve] of [["http", serveHttpProxy], ["socks5h", serveSocksProxy]] as const) {
        it(`sends pages, resources and robots.txt through the ${kind} proxy`, async () => {
            const proxy = await serve();
            try {
                const report = await audit({ seeds: [`${site.origin}/`], exclude: EXCLUDE, proxy: proxy.url, rules: ["seo", "resources"], concurrency: 2, cacheMode: "off" });
                assert.ok(report.pages.length > 3);
                assert.ok(proxy.seen.length >= report.pages.length, `${proxy.seen.length} requests proxied for ${report.pages.length} pages`);
                assert.ok(report.pages.every((page) => page.http.remote === undefined));
            } finally {
                await proxy.close();
            }
        });
    }
});
