// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, crawl, lintStore, loadPlugins, type Report } from "../src/index.ts";
import { PrivateAddress } from "../src/crawl/guard.ts";
import { probe } from "../src/crawl/probe.ts";
import { parsePin } from "../src/crawl/resolve.ts";
import { ENTRY_HOSTS, serveOrigin, type Origin } from "./fixtures/origin.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { runs } from "./fixtures/site-plugin.ts";

const EXCLUDE = ["/tmp/**"];

// Rule IDs of a report’s findings, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("origin preset", () => {
    let site: Fixture;
    let soft: Origin;
    let trace: Origin;
    let entry: Origin;

    before(async () => {
        [site, soft, trace, entry] = await Promise.all([serveFixture(), serveOrigin("soft"), serveOrigin("trace"), serveOrigin("entry")]);
    });

    after(() => Promise.all([site.close(), soft.close(), trace.close(), entry.close()]));

    // The entry-variant findings of a run seeded on `host` of the `entry` fixture.
    async function entryRules(host: string): Promise<string[]> {
        const port = new URL(entry.origin).port;
        const report = await audit({ seeds: [`http://${host}:${port}/page`], resolve: ENTRY_HOSTS.map((name) => parsePin(`${name}:127.0.0.1`)), rules: ["origin"], maxPages: 1, cacheMode: "off" });
        return rules(report).filter((rule) => /^origin\/(host-canonical|entry-|www-)/.test(rule));
    }

    it("probes the fixture origin once and faults none of its entry variants", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(rules(report), []);
        assert.equal(site.requested.filter((pathname) => pathname.startsWith("/spiderlint-")).length, 1);
        assert.deepEqual(report.summary.cost.extractors, { "cross-domain": 1, encodings: 1, favicon: 1, locale: 1, "not-found": 1, revalidation: 1, variants: 1 });
        assert.equal(site.headers.filter((headers) => headers["if-none-match"] !== undefined).length, 1, "the seed page is asked again with its ETag");
    });

    it("finds a soft 404, a language redirect, gzip alone, a favicon that is a page, an ignored ETag and an open cross-domain policy", async () => {
        const report = await audit({ seeds: [`${soft.origin}/`], rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(report.findings.find((finding) => finding.rule === "origin/cross-domain-policy")?.value, ["/crossdomain.xml"]);
        assert.deepEqual(rules(report), ["origin/compression", "origin/cross-domain-policy", "origin/favicon", "origin/locale-redirect", "origin/revalidation", "origin/soft-404"]);
        assert.match(report.findings.find((finding) => finding.rule === "origin/compression")?.message ?? "", /gzip/);
        assert.match(report.findings.find((finding) => finding.rule === "origin/soft-404")?.message ?? "", /answers 200/);
    });

    it("finds a stack trace on the not-found page and an entry that leaves the crawled origin", async () => {
        const report = await audit({ seeds: [`${trace.origin}/page`], rules: ["origin"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["origin/error-page", "origin/favicon", "origin/host-canonical"]);
    });

    it("faults a www host that 302s to the apex root, dropping the path", async () => {
        assert.deepEqual(await entryRules("drop.test"), ["origin/entry-path", "origin/entry-permanent"]);
    });

    it("faults a www host that reaches the apex in two hops through another host", async () => {
        assert.deepEqual(await entryRules("hops.test"), ["origin/entry-hops"]);
    });

    it("faults variants that land off the canonical origin", async () => {
        const port = new URL(entry.origin).port;
        const report = await audit({ seeds: [`http://www.hops.test:${port}/page`], resolve: ENTRY_HOSTS.map((name) => parsePin(`${name}:127.0.0.1`)), canonicalOrigin: `http://www.hops.test:${port}`, rules: ["origin"], maxPages: 1, cacheMode: "off" });
        assert.ok(rules(report).includes("origin/host-canonical"));
    });

    it("probes nothing when no enabled rule reads site.origins", async () => {
        const before = site.requested.length;
        await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"], cacheMode: "off" });
        assert.ok(site.requested.slice(before).every((pathname) => !pathname.startsWith("/spiderlint-") && pathname !== "/favicon.ico"));
    });
});

describe("rel=me", () => {
    let profiles: Server;
    let home: Server;
    let [profile, origin] = ["", ""];

    // A server answering each path from `pages`, else 404; its origin once listening.
    async function serve(pages: () => Record<string, string>): Promise<[Server, string]> {
        const server = createServer((request, response) => {
            const body = pages()[request.url ?? "/"];
            response.writeHead(body === undefined ? 404 : 200, { "content-type": "text/html; charset=utf-8" });
            response.end(body ?? "");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        return [server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`];
    }

    before(async () => {
        [profiles, profile] = await serve(() => ({ "/@me": `<link rel="me" href="${origin}/">`, "/@other": `<a href="${origin}/">Home</a>` }));
        [home, origin] = await serve(() => ({ "/": `<html><head><link rel="me" href="${profile}/@other"></head><body><a rel="me noopener" href="${profile}/@me">Me</a><a rel="me" href="${profile}/@gone">Gone</a></body></html>` }));
    });

    after(() => Promise.all([profiles, home].map((server) => new Promise((resolve) => server.close(resolve)))));

    it("flags a profile that does not link back with rel=me, and leaves an unreachable one unjudged", async () => {
        const report = await audit({ seeds: [`${origin}/`], rules: ["links/rel-me"], cacheMode: "off" });
        assert.deepEqual(
            report.findings.map((finding) => [finding.rule, finding.value]),
            [["links/rel-me", `${profile}/@other`]],
        );
        const { fetched, ...facts } = report.site.origins?.[origin]?.["rel-me"] as { fetched: Record<string, { status: number; at: string; cached?: true }> };
        assert.deepEqual(Object.fromEntries(Object.entries(fetched).map(([target, seen]) => [target, [seen.status, Number.isNaN(Date.parse(seen.at)), seen.cached]])), { [`${profile}/@other`]: [200, false, undefined], [`${profile}/@me`]: [200, false, undefined], [`${profile}/@gone`]: [404, false, undefined] });
        assert.match(report.findings[0]?.message ?? "", /\(read \d{4}-\d\d-\d\d \d\d:\d\d UTC; --refresh reads it again\)$/);
        assert.deepEqual(facts, { targets: [`${profile}/@other`, `${profile}/@me`, `${profile}/@gone`], unverified: [`${profile}/@other`], unreachable: [`${profile}/@gone`], declared: { [`${profile}/@other`]: [`${origin}/`], [`${profile}/@me`]: [`${origin}/`], [`${profile}/@gone`]: [`${origin}/`] } });
        assert.equal(report.findings[0]?.url, `${origin}/`);
    });
});

describe("rel=me profile cache", () => {
    let profiles: Server;
    let home: Server;
    let [profile, origin] = ["", ""];
    let isLinked = false;
    let directory = "";
    let previous: string | undefined;

    before(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-profiles-"));
        previous = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = directory;
        profiles = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(isLinked ? `<a rel="me" href="${origin}/">Home</a>` : "<p>nothing</p>");
        });
        await new Promise<void>((resolve) => profiles.listen(0, "127.0.0.1", resolve));
        profile = `http://127.0.0.1:${(profiles.address() as AddressInfo).port}`;
        home = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(`<html><body><a rel="me" href="${profile}/@me">Me</a></body></html>`);
        });
        await new Promise<void>((resolve) => home.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(home.address() as AddressInfo).port}`;
    });

    after(async () => {
        await Promise.all([profiles, home].map((server) => new Promise((resolve) => server.close(resolve))));
        if (previous === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = previous;
        await rm(directory, { recursive: true, force: true });
    });

    const seen = async (cacheMode: "use" | "refresh") => {
        const report = await audit({ seeds: [`${origin}/`], rules: ["links/rel-me"], cacheMode, sitemap: false });
        const facts = report.site.origins?.[origin]?.["rel-me"] as { unverified: string[]; fetched: Record<string, { cached?: true }> };
        return [facts.unverified.length, facts.fetched[`${profile}/@me`]?.cached];
    };

    it("answers a repeat run from the cache, and --refresh reads the profile again", async () => {
        assert.deepEqual(await seen("use"), [1, undefined]);
        isLinked = true;
        assert.deepEqual(await seen("use"), [1, true], "a fresh entry is reused");
        assert.deepEqual(await seen("refresh"), [0, undefined], "--refresh sees the new back-link");
    });
});

describe("site extractor plugins", () => {
    let site: Fixture;
    let directory: string;

    before(async () => {
        site = await serveFixture();
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-sites-"));
        await loadPlugins(["./tests/fixtures/site-plugin.ts"]);
    });

    after(async () => {
        await site.close();
        await rm(directory, { recursive: true, force: true });
    });

    it("runs a per-host extractor once, keys its facts by host, and gives up on one past its timeout", async () => {
        const store = path.join(directory, "store");
        const started = Date.now();
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"] }, { store });
        assert.deepEqual(
            report.findings.map((finding) => [finding.rule, finding.url, finding.value]),
            [["hosts/robots-gone", "127.0.0.1", 200]],
        );
        assert.deepEqual(runs, { robots: 1, stuck: 1 });
        assert.ok(Date.now() - started < 10_000, "the stuck extractor is abandoned at its timeout");
    });

    it("answers a re-crawl from the origins bucket and an offline audit from the store", async () => {
        const store = path.join(directory, "store");
        const again = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"] }, { store });
        const offline = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["hosts"], cacheMode: "offline" }, { store });
        assert.deepEqual(runs, { robots: 1, stuck: 2 });
        assert.deepEqual(rules(again), ["hosts/robots-gone"]);
        assert.deepEqual(rules(offline), ["hosts/robots-gone"]);
    });

    it("skips its rules on a store crawled without them, probing nothing", async () => {
        const store = path.join(directory, "plain");
        await crawl({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["seo"] }, store);
        const linted = await lintStore({ rules: ["hosts"] }, store);
        assert.deepEqual(linted.findings, []);
        assert.equal(linted.summary.checks.total, 0);
        assert.deepEqual(runs, { robots: 1, stuck: 2 });
    });
});

describe("probe", () => {
    let site: Fixture;

    before(async () => {
        site = await serveFixture();
    });

    after(() => site.close());

    it("refuses a private address unless allowed, and any URL off its host", async () => {
        const signal = new AbortController().signal;
        await assert.rejects(probe(`${site.origin}/`, {}, { host: "127.0.0.1", allowPrivate: false, signal }), PrivateAddress);
        await assert.rejects(probe("http://localhost/", {}, { host: "127.0.0.1", allowPrivate: true, signal }), /leaves host/);
        const answer = await probe(`${site.origin}/old-about`, { redirect: "follow" }, { host: "127.0.0.1", allowPrivate: true, signal });
        assert.deepEqual([answer.status, answer.redirects.map((hop) => hop.status)], [200, [301]]);
    });
});
