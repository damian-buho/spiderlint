// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { load } from "cheerio";
import { chromium } from "playwright";
import { declaredHtml, extractHtml } from "../src/facts/html.ts";
import { parityFacts } from "../src/facts/parity.ts";
import { audit } from "../src/index.ts";

const TEXT = "Server-side rendering keeps every word of this paragraph readable to a crawler that never runs a script. ".repeat(4);
const BODY = `<main><h1>Parity</h1><p>${TEXT}</p><a href="/server">Server</a> <a href="/client">Client</a></main>`;
const HEAD = `<title>Parity</title><meta name="description" content="Both renders agree"><link rel="canonical" href="/server">`;
const SCRIPT = `<script>document.head.insertAdjacentHTML("beforeend", ${JSON.stringify(HEAD)}); document.querySelector("main").outerHTML = ${JSON.stringify(BODY)};</script>`;
// A server-rendered page and a client-rendered one that end up showing the same DOM.
const PAGES: Record<string, string> = {
    "/server": `<!DOCTYPE html><html lang="en"><head>${HEAD}</head><body>${BODY}</body></html>`,
    "/client": `<!DOCTYPE html><html lang="en"><head></head><body><main></main>${SCRIPT}</body></html>`,
};

type Cheerio = Parameters<typeof extractHtml>[0];
const facts = (html: string) => {
    const $ = load(html) as unknown as Cheerio;
    return { $, html: extractHtml($, html, new URL("https://site.test/client"), "origin") };
};

describe("served declarations", () => {
    it("keeps what the served HTML declares, takes what only a script adds, and names what a script changed", () => {
        const served = facts('<html><head><meta charset="utf8"><meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)"><link rel="canonical" href="/a"></head></html>').html;
        const rendered = facts('<html><head><meta name="theme-color" content="#fff"><link rel="canonical" href="/a"><meta name="description" content="Added by a script"><meta property="og:title" content="Added"></head></html>').html;
        const html = declaredHtml(served, rendered);
        assert.deepEqual(
            html.metas.map((meta) => [meta.name, meta.content, meta.media]),
            [
                ["theme-color", "#fff", "(prefers-color-scheme: light)"],
                ["theme-color", "#000", "(prefers-color-scheme: dark)"],
                ["description", "Added by a script", undefined],
            ],
        );
        assert.deepEqual([html.meta["theme-color"], html.meta.description, html.property["og:title"], html.canonical, html.charset?.declared], ["#fff", "Added by a script", "Added", "/a", "utf8"]);
        assert.deepEqual(html.rewritten, [{ tag: '<meta name="theme-color">', served: ["#fff (prefers-color-scheme: light)", "#000 (prefers-color-scheme: dark)"], rendered: ["#fff"] }]);
        assert.equal(declaredHtml(served, served).rewritten, undefined);
    });
});

describe("parity facts", () => {
    it("lists what only the render carries", () => {
        const raw = facts(PAGES["/client"] as string);
        const rendered = facts(PAGES["/server"] as string);
        const parity = parityFacts("https://site.test/client", raw.$, raw.html, rendered.$, rendered.html);
        assert.deepEqual(parity.missing, { title: "Parity", description: "Both renders agree", canonical: "/server", h1: ["Parity"], links: ["https://site.test/server", "https://site.test/client"] });
        assert.equal(parity["text-share"], 0);
    });

    it("lists nothing when both agree, counting <noscript> text only without scripts", () => {
        const page = facts(PAGES["/server"] as string);
        assert.deepEqual(parityFacts("https://site.test/server", page.$, page.html, page.$, page.html).missing, {});
        const fallback = facts(`<body><main><noscript>${TEXT}</noscript></main></body>`);
        const parity = parityFacts("https://site.test/", fallback.$, fallback.html, facts(BODY).$, facts(BODY).html);
        assert.ok((parity["text-share"] ?? 0) > 0.9, String(parity["text-share"]));
    });
});

describe("parity rules", () => {
    let server: Server;
    let origin: string;
    before(async () => {
        server = createServer((request, response) => {
            const page = PAGES[request.url ?? ""];
            response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(page ?? "");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    it("skips the kind on an http crawl", async () => {
        const report = await audit({ seeds: [`${origin}/client`], maxPages: 1, sitemap: false, groups: { default: { rules: ["parity"] } } });
        assert.equal(report.pages[0]?.parity, undefined);
        assert.deepEqual(report.findings, []);
    });

    it("fails a client-rendered page on each rule and passes a server-rendered one", async (context) => {
        try {
            const browser = await chromium.launch();
            await browser.close();
        } catch (error) {
            return context.skip(`chromium does not launch: ${String(error).split("\n", 1)[0]}`);
        }
        const report = await audit({ seeds: [`${origin}/client`, `${origin}/server`], sitemap: false, fetch: "browser", groups: { default: { rules: ["parity"] } } });
        const byUrl = (path: string) =>
            report.findings
                .filter((finding) => finding.url === `${origin}${path}`)
                .map((finding) => finding.rule)
                .toSorted((a, b) => a.localeCompare(b));
        assert.deepEqual(byUrl("/client"), ["parity/canonical", "parity/description", "parity/h1", "parity/links", "parity/text", "parity/title"]);
        assert.deepEqual(byUrl("/server"), []);
    });
});
