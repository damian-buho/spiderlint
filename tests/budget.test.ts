// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { translator } from "../src/i18n.ts";
import { audit, type Report } from "../src/index.ts";
import { reportBody } from "../src/report/html.ts";

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Home</title><script src="/app.js"></script></head><body><h1>Home</h1><img src="/one.png" alt=""><img src="/two.png" alt=""><a href="/other">Other</a></body></html>`;
const HANGING = PAGE.replace("/app.js", "/hang.js");

// The sitemap XML of `kind` naming each of `paths` under `origin`.
function xml(kind: "sitemapindex" | "urlset", origin: string, paths: string[]): string {
    const tag = kind === "urlset" ? "url" : "sitemap";
    return `<?xml version="1.0"?><${kind} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((entry) => `<${tag}><loc>${origin}${entry}</loc></${tag}>`).join("")}</${kind}>`;
}

// The resources of a report that got an answer, by path.
function fetched(report: Report): string[] {
    return report.pages.flatMap((page) => page.resources ?? []).flatMap((entry) => (entry.http ? [new URL(entry.url).pathname] : []));
}

describe("scan budgets", () => {
    let server: Server;
    let origin: string;

    before(async () => {
        server = createServer((request, response) => {
            const route = request.url ?? "/";
            if (route === "/hang.js") return;
            const send = (type: string, body: string) => response.writeHead(200, { "content-type": type }).end(body);
            if (route === "/sitemap.xml") return send("application/xml", xml("sitemapindex", origin, ["/first.xml", "/second.xml"]));
            if (route === "/first.xml") return send("application/xml", xml("urlset", origin, ["/"]));
            if (route === "/second.xml") return send("application/xml", xml("urlset", origin, ["/other"]));
            if (route === "/hanging") return send("text/html", HANGING);
            if (route === "/" || route === "/other") return send("text/html", PAGE);
            if (route === "/robots.txt") return send("text/plain", "User-agent: *\nAllow: /\n");
            if (route.endsWith(".js")) return send("text/javascript", "x");
            if (route.endsWith(".png")) return send("image/png", "x");
            return response.writeHead(404).end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.closeAllConnections();
        server.close();
    });

    const run = async (overrides: Parameters<typeof audit>[0]) => audit({ seeds: [`${origin}/`], cacheMode: "off", rules: ["sitemap", "resources"], concurrency: 2, maxPages: 2, ...overrides });

    it("reads every sitemap file at max-sitemaps 0", async () => {
        const report = await run({ maxSitemaps: 0 });
        assert.equal(report.site?.sitemaps?.length, 3);
    });

    it("reads exactly max-sitemaps files, and judges no page the cut files may list", async () => {
        const report = await run({ maxSitemaps: 2 });
        assert.equal(report.site?.sitemaps?.length, 2);
        assert.deepEqual(
            report.findings.filter((finding) => finding.rule === "sitemap/unlisted"),
            [],
        );
    });

    it("reads all files when max-sitemaps equals their count", async () => {
        const report = await run({ maxSitemaps: 3 });
        assert.equal(report.site?.sitemaps?.length, 3);
    });

    it("fetches exactly max-resources, images last", async () => {
        const report = await run({ maxResources: 2 });
        assert.deepEqual(
            [...new Set(fetched(report))].toSorted((a, b) => a.localeCompare(b)),
            ["/app.js", "/one.png"],
        );
    });

    it("fetches every resource at max-resources 0", async () => {
        const report = await run({ maxResources: 0 });
        assert.deepEqual(
            [...new Set(fetched(report))].toSorted((a, b) => a.localeCompare(b)),
            ["/app.js", "/one.png", "/two.png"],
        );
    });

    it("marks no report of a run inside its deadline", async () => {
        const report = await run({});
        assert.equal(report.summary.incomplete, undefined);
    });

    it("lints what it has and says so once the analysis deadline passes", async () => {
        const report = await run({ seeds: [`${origin}/hanging`], analysisDeadline: 1, maxPages: 1 });
        assert.equal(report.site?.crawl?.reason, "analysis-timeout");
        assert.equal(report.site?.crawl?.complete, false);
        assert.equal(report.summary.incomplete, "analysis-timeout");
        assert.equal(report.pages.length, 1);
    });

    it("puts a notice on a report that ran out of time, and none on a whole one", async () => {
        const report = await run({});
        const notice = '<p class="notice">';
        assert.ok(!reportBody(report, translator("en"), "site", origin).includes(notice));
        assert.ok(reportBody({ ...report, summary: { ...report.summary, incomplete: "timeout" } }, translator("en"), "site", origin).includes(notice));
    });
});
