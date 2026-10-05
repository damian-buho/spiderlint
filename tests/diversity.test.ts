// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Spread } from "../src/crawl/diversity.ts";
import { audit } from "../src/index.ts";

const ORIGIN = "https://site.test";

function pool(limit: number, paths: string[]): Spread {
    const spread = new Spread(limit);
    for (const path of paths) spread.add({ url: `${ORIGIN}${path}`, crawlDepth: 1 });
    return spread;
}

const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

describe("spread pool", () => {
    it("takes an unseen section before a third page of a seen one", () => {
        const spread = pool(100, [...numbered("/post/", 50), ...numbered("/tag/", 50), "/project/"]);
        spread.note(`${ORIGIN}/post/seen`);
        spread.note(`${ORIGIN}/tag/seen`);
        const urls = spread.take(3).map((candidate) => candidate.url);
        assert.ok(urls.includes(`${ORIGIN}/project/`), urls.join(" "));
    });

    it("shares a budget between sections evenly", () => {
        const spread = pool(100, [...numbered("/post/", 40), ...numbered("/tag/", 40), ...numbered("/docs/guide/", 40), ...numbered("/docs/api/", 40)]);
        const sections = Object.groupBy(spread.take(12), (candidate) => new URL(candidate.url).pathname.split("/", 2)[1] as string);
        assert.deepEqual(Object.fromEntries(Object.entries(sections).map(([name, urls]) => [name, urls?.length])), { post: 4, tag: 4, docs: 4 });
    });

    it("keeps arrival order inside one section", () => {
        const urls = pool(100, numbered("/post/", 5))
            .take(5)
            .map((candidate) => candidate.url);
        assert.deepEqual(
            urls,
            numbered("/post/", 5).map((path) => `${ORIGIN}${path}`),
        );
    });

    it("drops a repeat, a fragment variant and a page past its directory’s limit", () => {
        const spread = new Spread(2);
        assert.equal(spread.add({ url: `${ORIGIN}/post/a`, crawlDepth: 1 }), true);
        assert.equal(spread.add({ url: `${ORIGIN}/post/a#top`, crawlDepth: 1 }), false);
        assert.equal(spread.add({ url: `${ORIGIN}/post/b`, crawlDepth: 1 }), true);
        assert.equal(spread.add({ url: `${ORIGIN}/post/c`, crawlDepth: 1 }), false);
        assert.equal(spread.size, 2);
    });

    it("loses no page when names past the fan-out fold into one share", () => {
        const spread = pool(
            1000,
            numbered("/user/name", 200).map((path) => `${path}/page`),
        );
        assert.equal(spread.size, 200);
        assert.equal(spread.take(1000).length, 200);
        assert.equal(spread.size, 0);
    });

    it("empties a pool it has no candidates for", () => {
        assert.deepEqual(new Spread(5).take(3), []);
    });
});

const page = (body: string) => `<!doctype html><html lang="en"><head><title>t</title></head><body><main>${body}</main></body></html>`;
const links = (prefix: string) =>
    numbered(`${prefix}/`, 12)
        .map((href) => `<a href="${href}">${href}</a>`)
        .join("");

describe("page budget spread over a crawl", () => {
    let server: Server;
    let origin: string;

    before(async () => {
        server = createServer((request, response) => {
            const path = new URL(request.url ?? "/", "http://x").pathname;
            const home = `${links("/post")}${links("/tag")}<a href="/project/">projects</a><a href="/about">about</a>`;
            response.writeHead(path === "/robots.txt" || path === "/sitemap.xml" ? 404 : 200, { "content-type": "text/html" });
            response.end(page(path === "/" ? home : `<h1>${path}</h1>`));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
    });

    const crawl = async (isDiverse: boolean, maxPages = 6) => {
        const report = await audit({ seeds: [`${origin}/`], maxPages, concurrency: 1, diversify: isDiverse, sitemap: false, robots: false, fetchResources: false, cacheMode: "off", rules: [] });
        return report.pages.map((facts) => facts.url.pathname);
    };

    it("reaches every section within the budget", async () => {
        const paths = await crawl(true);
        assert.equal(paths.length, 6);
        for (const section of ["/project/", "/about"]) assert.ok(paths.includes(section), paths.join(" "));
        assert.ok(
            paths.some((path) => path.startsWith("/post/")),
            paths.join(" "),
        );
        assert.ok(
            paths.some((path) => path.startsWith("/tag/")),
            paths.join(" "),
        );
    });

    it("visits the unseen sections first without a page limit, and still every page", async () => {
        const paths = await crawl(true, 0);
        assert.equal(paths.length, 27);
        assert.ok(paths.indexOf("/project/") < 6, paths.join(" "));
        assert.ok(paths.indexOf("/about") < 6, paths.join(" "));
    });

    it("follows discovery order once diversify is off", async () => {
        const paths = await crawl(false);
        assert.ok(!paths.includes("/project/"), paths.join(" "));
    });
});

describe("sitemap pages in a cut crawl", () => {
    let server: Server;
    let origin: string;

    before(async () => {
        const pages: Record<string, string> = { "/": `<a href="/hub">hub</a>`, "/hub": `<a href="/leaf">leaf</a>`, "/leaf": "<p>leaf</p>" };
        server = createServer((request, response) => {
            const path = new URL(request.url ?? "/", "http://x").pathname;
            const sitemap = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/leaf</loc></url></urlset>`;
            const body = path === "/sitemap.xml" ? sitemap : pages[path];
            response.writeHead(body === undefined ? 404 : 200, { "content-type": path === "/sitemap.xml" ? "application/xml" : "text/html" });
            response.end(body === undefined ? "" : path === "/sitemap.xml" ? body : page(body));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
    });

    const orphans = async (maxPages: number) => {
        const report = await audit({ seeds: [`${origin}/`], maxPages, concurrency: 1, sitemap: true, robots: false, fetchResources: false, cacheMode: "off", rules: ["sitemap/orphan"] });
        return report.findings.filter((finding) => finding.rule === "sitemap/orphan").map((finding) => finding.url);
    };

    it("names no orphan while the pages that may link to it are uncrawled", async () => {
        assert.deepEqual(await orphans(2), []);
    });

    it("finds no orphan once the crawl is whole and the sitemap page is linked", async () => {
        assert.deepEqual(await orphans(0), []);
    });
});
