// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigError } from "../src/config/index.ts";
import { api } from "../src/server/api.ts";
import { admit, policyFor, Refusal } from "../src/server/policy.ts";
import { connect, scanQueue } from "../src/server/queue.ts";
import { hostSuffix, settingsOf } from "../src/server/settings.ts";
import { startWorker } from "../src/server/worker.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const SETTINGS = settingsOf({
    policies: [
        { name: "ru", hosts: ["ru", "рф"], ban: true },
        { name: "ua", hosts: [".ua"], rate: { jobs: 1, per: "1h" }, caps: { "max-pages": 20, concurrency: 2 }, rules: { allow: ["seo", "http/*"], deny: ["http/alt-svc-h3"] } },
        { name: "rest", hosts: ["*"] },
    ],
});

// The Refusal code `run` throws.
function refusal(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof Refusal) return error.code;
        throw error;
    }
    return "admitted";
}

describe("server settings", () => {
    it("reads a host suffix in any spelling as punycode", () => {
        assert.equal(hostSuffix("*.UA"), "ua");
        assert.equal(hostSuffix(".ua."), "ua");
        assert.equal(hostSuffix("рф"), "xn--p1ai");
        assert.equal(hostSuffix("*"), "*");
    });

    it("defaults to one policy admitting every host, http only, 100 pages", () => {
        const [policy] = settingsOf({}).policies;
        assert.deepEqual([policy?.hosts, policy?.fetch, policy?.caps["max-pages"], policy?.scanTimeout], [["*"], ["http"], 100, 600]);
    });

    it("refuses the browser while private addresses are refused", () => {
        assert.throws(() => settingsOf({ policies: [{ name: "b", hosts: ["*"], fetch: ["browser"] }] }), ConfigError);
        assert.doesNotThrow(() => settingsOf({ "allow-private": true, policies: [{ name: "b", hosts: ["*"], fetch: ["browser"] }] }));
    });

    it("names an unknown key and a bad default", () => {
        assert.throws(() => settingsOf({ polices: [] }), /unknown key "polices"/);
        assert.throws(() => settingsOf({ defaults: { "max-pages": "lots" } }), /server\/defaults\/max-pages/);
    });
});

describe("server policy", () => {
    it("matches the first policy whose suffix ends the host", () => {
        assert.equal(policyFor("xn--80ak6aa92e.xn--p1ai", SETTINGS.policies)?.name, "ru");
        assert.equal(policyFor("kyiv.gov.ua", SETTINGS.policies)?.name, "ua");
        assert.equal(policyFor("mua", SETTINGS.policies)?.name, "rest");
    });

    it("refuses bans, bad seeds and settings a request may not set", () => {
        assert.equal(refusal(() => admit({ url: "https://кремль.рф/" }, SETTINGS)), "banned");
        assert.equal(refusal(() => admit({ url: "file:///etc/passwd" }, SETTINGS)), "invalid-url");
        assert.equal(refusal(() => admit({ url: "https://user:pass@example.com/" }, SETTINGS)), "invalid-url");
        assert.equal(refusal(() => admit({ url: "https://example.com/", settings: { plugins: ["./x.ts"] } }, SETTINGS)), "forbidden-setting");
        assert.equal(refusal(() => admit({ url: "https://example.com/", settings: { robots: false } }, SETTINGS)), "forbidden-setting");
        assert.equal(refusal(() => admit({ url: "https://example.com/", settings: { "max-pages": -1 } }, SETTINGS)), "invalid-settings");
        assert.equal(refusal(() => admit({ url: "https://example.com/", settings: { fetch: "browser" } }, SETTINGS)), "forbidden-fetch");
    });

    it("allows named rules only, and treats no rules as recommended", () => {
        assert.equal(refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["seo", "http/hsts"] } }, SETTINGS)), "admitted");
        assert.equal(refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["http/alt-svc-h3"] } }, SETTINGS)), "forbidden-rule");
        assert.equal(refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["all"] } }, SETTINGS)), "forbidden-rule");
        assert.equal(refusal(() => admit({ url: "https://a.ua/" }, SETTINGS)), "forbidden-rule");
        assert.equal(refusal(() => admit({ url: "https://a.ua/", settings: { groups: { blog: { match: ["/blog/**"], rules: ["seo"] } } } }, SETTINGS)), "forbidden-rule");
    });

    it("clamps to the caps, where 0 or unset is unlimited, and pins the guard", () => {
        const { settings } = admit({ url: "https://a.ua/", settings: { rules: ["seo"], "max-pages": 0, concurrency: 1 } }, SETTINGS);
        assert.deepEqual([settings["max-pages"], settings.concurrency, settings.fetch, settings.robots, settings["allow-private"]], [20, 1, "http", true, false]);
        assert.equal(admit({ url: "https://a.ua/", settings: { rules: ["seo"], "max-pages": 500 } }, SETTINGS).settings["max-pages"], 20);
    });
});

describe("server over Redis", { skip: process.env.SPIDERLINT_TEST_REDIS === undefined && "SPIDERLINT_TEST_REDIS unset" }, () => {
    let site: Fixture;
    const [redis, workerRedis] = [connect(process.env.SPIDERLINT_TEST_REDIS ?? ""), connect(process.env.SPIDERLINT_TEST_REDIS ?? "")];
    const queue = scanQueue(redis, 60);
    const worker = startWorker(workerRedis, 1);
    const settings = settingsOf({ "allow-private": true, policies: [{ name: "fixture", hosts: ["127.0.0.1"], rate: { jobs: 1, per: 60 }, caps: { "max-pages": 3 } }] });
    const app = api(queue, redis, () => settings);

    before(async () => {
        site = await serveFixture();
        await redis.del(`spiderlint:rate:fixture:127.0.0.1`);
    });

    after(async () => {
        await worker.close();
        await queue.close();
        await redis.quit();
        await workerRedis.quit();
        await site.close();
    });

    it("queues a scan, reports its progress, then every format", async () => {
        const created = await app.request("/v1/jobs", { method: "POST", body: JSON.stringify({ url: `${site.origin}/`, settings: { rules: ["seo"] } }) });
        assert.equal(created.status, 202);
        const { id } = (await created.json()) as { id: string };
        let job: { status: string; progress?: { done: number }; summary?: { pages: number } } = { status: "queued" };
        for (let tries = 0; tries < 120 && !["done", "failed"].includes(job.status); tries += 1) {
            await sleep(500);
            const response = await app.request(`/v1/jobs/${id}`);
            job = (await response.json()) as typeof job;
        }
        assert.equal(job.status, "done");
        assert.equal(job.summary?.pages, 3);
        assert.equal(job.progress?.done, 3);
        const sarif = await app.request(`/v1/jobs/${id}/report/sarif`);
        assert.equal(sarif.headers.get("content-type"), "application/sarif+json; charset=utf-8");
        const document = (await sarif.json()) as { version: string };
        assert.equal(document.version, "2.1.0");
        const pdf = await app.request(`/v1/jobs/${id}/report/pdf`);
        assert.equal(pdf.status, 404);
    });

    it("refuses a second scan inside the host’s window", async () => {
        const again = await app.request("/v1/jobs", { method: "POST", body: JSON.stringify({ url: `${site.origin}/` }) });
        assert.equal(again.status, 429);
        assert.ok(Number(again.headers.get("retry-after")) > 0);
    });
});
