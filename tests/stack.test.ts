// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DnsClient } from "../src/crawl/dns.ts";
import type { Facts } from "../src/facts/types.ts";
import stack from "../src/plugins/stack.ts";

const ORIGIN = "https://example.org";

// A page of the origin answering with `headers`.
function page(headers: Record<string, string>): Facts {
    return { url: new URL(`${ORIGIN}/`), http: { status: 200, headers, cookies: [], timing: {}, size: { body: 0 } } } as unknown as Facts;
}

// The `stack` fact of the origin, at `address`, with `list` standing in for the published range lists.
async function detected(pages: Facts[], address: string, list: (url: string) => Promise<string> = () => Promise.reject(new Error("no http here"))): Promise<Record<string, unknown> | undefined> {
    const [extractor] = stack.sites ?? [];
    const fail = () => Promise.reject(new Error("no http here"));
    return extractor?.extract(ORIGIN, {
        pages,
        signal: AbortSignal.timeout(10_000),
        dns: { query: fail } as unknown as DnsClient,
        fetch: fail,
        delegated: fail,
        link: fail,
        cached: fail,
        list,
        address: async () => address,
    }) as Promise<Record<string, unknown> | undefined>;
}

describe("stack plugin", () => {
    it("reports Cloudflare as the edge with its evidence behind its address range and cf-ray header", async () => {
        const facts = await detected([page({ "cf-ray": "8a1b-AMS", server: "cloudflare" })], "104.16.0.1");
        assert.deepEqual(facts, { edge: { name: "cloudflare", kind: "edge", evidence: ["address 104.16.0.1", "header cf-ray: 8a1b-AMS", "header server: cloudflare"], confidence: "high" } });
    });

    it("is medium confidence on one signal, and takes the web server beside the edge", async () => {
        const facts = await detected([page({ server: "nginx/1.27", "cf-ray": "1" })], "192.0.2.7");
        assert.deepEqual(facts, {
            edge: { name: "cloudflare", kind: "edge", evidence: ["header cf-ray: 1"], confidence: "medium" },
            server: { name: "nginx", kind: "server", evidence: ["header server: nginx/1.27"], confidence: "medium" },
        });
    });

    it("reports nothing where no signal matches", async () => {
        assert.equal(await detected([page({ server: "caddy" })], "192.0.2.7"), undefined);
    });

    it("takes the ranges from the downloaded lists, and the bundled ones when the download fails", async () => {
        const asked: string[] = [];
        const downloaded = await detected([], "127.0.0.1", async (url) => {
            asked.push(url);
            return url.endsWith("ips-v4") ? "127.0.0.0/8\n" : "2606:4700::/32\n";
        });
        assert.deepEqual([(downloaded?.edge as { name: string }).name, asked], ["cloudflare", ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"]]);
        assert.equal(await detected([], "127.0.0.1"), undefined);
    });
});
