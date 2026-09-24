// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fetchCached, type Stored } from "../src/cache/http.ts";
import { Bucket, OfflineMiss, bucketDirectory, parseDuration } from "../src/cache/index.ts";
import { purgeCache } from "../src/cache/purge.ts";
import { cacheStatus } from "../src/cache/status.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const text = async (response: Response) => response.text();

describe("cache", () => {
    let root: string;
    let site: Fixture;

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "spiderlint-cache-"));
        process.env.XDG_CACHE_HOME = path.join(root, "user");
        site = await serveFixture();
    });

    after(async () => {
        await site.close();
        await rm(root, { recursive: true, force: true });
    });

    it("parses durations in seconds, minutes, hours and days", () => {
        assert.equal(parseDuration(90), 90);
        assert.equal(parseDuration("45s"), 45);
        assert.equal(parseDuration("30m"), 1800);
        assert.equal(parseDuration("24h"), 86_400);
        assert.equal(parseDuration("7d"), 604_800);
        assert.equal(parseDuration("a week"), undefined);
        assert.equal(parseDuration(-1), undefined);
    });

    it("keeps project buckets in the store and robots in the user cache", () => {
        assert.equal(bucketDirectory("resources", "/s"), path.join("/s", "cache", "resources"));
        assert.equal(bucketDirectory("resources", undefined), undefined);
        assert.equal(bucketDirectory("robots", undefined), path.join(root, "user", "spiderlint", "robots"));
    });

    it("round-trips an entry and ages it against the TTL", async () => {
        const bucket = new Bucket<{ n: number }>("resources", path.join(root, "store", "cache", "resources"), 60, "use");
        assert.equal(await bucket.get("https://a.test/x.js"), undefined);
        await bucket.set("https://a.test/x.js", { n: 1 });
        const entry = await bucket.get("https://a.test/x.js");
        assert.deepEqual(entry?.value, { n: 1 });
        assert.ok(entry && bucket.isFresh(entry));
        assert.ok(!new Bucket("resources", bucket.directory, 0, "use").isFresh(entry));
    });

    it("never reads under off or refresh, writes only under refresh, and ends an offline miss", async () => {
        const directory = path.join(root, "modes");
        await new Bucket("sitemaps", directory, 60, "off").set("k", 1);
        await assert.rejects(readdir(directory), { code: "ENOENT" });
        const refresh = new Bucket("sitemaps", directory, 60, "refresh");
        await refresh.set("k", 2);
        assert.equal(await refresh.get("k"), undefined);
        const used = await new Bucket("sitemaps", directory, 60, "use").get("k");
        assert.equal(used?.value, 2);
        const offline = new Bucket("sitemaps", directory, 60, "offline");
        const served = await offline.get("k");
        assert.equal(served?.value, 2);
        assert.throws(() => offline.missed("absent"), OfflineMiss);
    });

    it("lists file buckets and purges only entries past --older-than", async () => {
        const store = path.join(root, "purge");
        const bucket = new Bucket<number>("resources", bucketDirectory("resources", store), 60, "use");
        await bucket.set("a", 1);
        await bucket.set("b", 2);
        const [first] = await readdir(bucket.directory as string);
        await utimes(path.join(bucket.directory as string, first as string), new Date(0), new Date(0));
        const before = await cacheStatus(store);
        assert.equal(before.find((status) => status.bucket === "resources")?.entries, 2);
        assert.deepEqual(await purgeCache(store, "resources", 3600), { resources: 1 });
        assert.deepEqual(await purgeCache(store, "resources", 0), { resources: 1 });
        const emptied = await cacheStatus(store);
        assert.equal(emptied.find((status) => status.bucket === "resources"), undefined);
    });

    it("serves a fresh entry without a request and revalidates a stale one to 304", async () => {
        const directory = path.join(root, "http");
        const url = `${site.origin}/feed.xml`;
        const count = () => site.requested.filter((pathname) => pathname === "/feed.xml").length;
        const fresh = new Bucket<Stored<string>>("resources", directory, 60, "use");
        const first = await fetchCached(fresh, url, text);
        assert.equal(first.status, 200);
        assert.ok(first.value.length > 0);
        const requests = count();
        const second = await fetchCached(fresh, url, text);
        assert.equal(second.cached, true);
        assert.equal(count(), requests);
        const stale = new Bucket<Stored<string>>("resources", directory, 0, "use");
        const third = await fetchCached(stale, url, text);
        assert.equal(third.revalidated, true);
        assert.equal(third.status, 200);
        assert.equal(third.value, first.value);
        assert.equal(site.headers.at(-1)?.["if-none-match"], first.headers.etag);
    });
});
