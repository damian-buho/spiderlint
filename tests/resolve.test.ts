// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { ConfigError } from "../src/config/index.ts";
import { parsePin } from "../src/crawl/resolve.ts";
import { audit } from "../src/index.ts";
import { serveDns, type DnsFixture } from "./fixtures/dns.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

describe("resolve pins", () => {
    it("reads host:address and curl’s host:port:address, and refuses anything else", () => {
        assert.deepEqual(parsePin("Pinned.Fixture:127.0.0.1"), { host: "pinned.fixture", address: "127.0.0.1" });
        assert.deepEqual(parsePin("pinned.fixture:443:[::1]"), { host: "pinned.fixture", address: "::1" });
        assert.throws(() => parsePin("pinned.fixture"), ConfigError);
        assert.throws(() => parsePin("pinned.fixture:elsewhere.fixture"), ConfigError);
    });
});

describe("crawl resolution", () => {
    let site: Fixture;
    let resolver: DnsFixture;

    before(async () => {
        [site, resolver] = await Promise.all([serveFixture(), serveDns()]);
    });

    after(async () => {
        await Promise.all([site.close(), resolver.close()]);
    });

    it("crawls a name only the configured resolver knows, then restores the system lookup", async () => {
        const system = dns.lookup;
        const seed = `http://only.fixture:${new URL(site.origin).port}/about`;
        const report = await audit({ seeds: [seed], resolver: resolver.server, maxPages: 1, sitemap: false, robots: false, fetchResources: false });
        assert.equal(report.pages[0]?.url.href, seed);
        assert.equal(report.pages[0]?.http.status, 200);
        assert.ok(resolver.queries.includes("only.fixture|A"));
        assert.equal(dns.lookup, system);
    });

    it("crawls a name pinned by --resolve", async () => {
        const seed = `http://pinned.fixture:${new URL(site.origin).port}/about`;
        const report = await audit({ seeds: [seed], resolve: [parsePin("pinned.fixture:127.0.0.1")], maxPages: 1, sitemap: false, robots: false, fetchResources: false });
        assert.equal(report.pages[0]?.http.status, 200);
    });
});
