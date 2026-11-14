// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { audit, type Report } from "../src/index.ts";

const PAGE = '<!doctype html><html lang="en"><title>p</title><h1>p</h1>';

// A site whose `/` answers 429 with `Retry-After: 0` for its first `limited` requests, then 200 with nosniff; returns it and its `/` request count.
async function serve(limited: number): Promise<{ server: Server; origin: string; hits: () => number }> {
    let hits = 0;
    const server = createServer((request, response) => {
        if (request.url !== "/") return response.writeHead(404).end();
        hits += 1;
        if (hits <= limited) return response.writeHead(429, { "retry-after": "0", "content-type": "text/html" }).end("slow down");
        response.writeHead(200, { "content-type": "text/html", "x-content-type-options": "nosniff" }).end(PAGE);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

// The rule IDs a report found, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("rate-limited pages", () => {
    it("retries a 429 and judges the 200 that follows", async () => {
        const site = await serve(1);
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["security-headers", "links"], cacheMode: "off", fetchResources: false, robots: false, sitemap: false });
        site.server.close();
        assert.equal(site.hits(), 2);
        assert.ok(!rules(report).includes("http/content-type-options/missing"), rules(report).join(", "));
        assert.ok(!rules(report).includes("links/internal/unreachable"), rules(report).join(", "));
    });

    it("reports a page that keeps answering 429 once, as unreachable, and judges none of its headers", async () => {
        const site = await serve(Infinity);
        const report = await audit({ seeds: [`${site.origin}/`], rules: ["security-headers", "links"], cacheMode: "off", fetchResources: false, robots: false, sitemap: false });
        site.server.close();
        assert.equal(site.hits(), 4);
        assert.deepEqual(rules(report), ["links/internal/unreachable"]);
        assert.equal(report.findings[0]?.value, 429);
    });
});
