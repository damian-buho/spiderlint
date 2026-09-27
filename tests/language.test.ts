// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { audit, type Report } from "../src/index.ts";

// A page declaring `lang`, with its title and description.
const page = (lang: string, title: string, description: string) => `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title><meta name="description" content="${description}"></head><body><h1>${title}</h1><a href="/en">en</a><a href="/es">es</a><a href="/uk">uk</a><a href="/es-mixed">mixed</a><a href="/short">short</a></body></html>`;
const PAGES: Record<string, string> = {
    "/en": page("en-GB", "How to bake sourdough bread at home", "A step-by-step guide to a crisp crust and an open crumb, from starter to oven."),
    "/es": page("es", "Cómo hacer pan de masa madre en casa", "Una guía paso a paso para lograr una corteza crujiente y una miga abierta."),
    "/uk": page("uk", "Як спекти хліб на заквасці вдома", "Покроковий посібник для хрусткої скоринки та пористого м’якуша."),
    "/es-mixed": page("es", "How to bake sourdough bread at home", "Una guía paso a paso para lograr una corteza crujiente y una miga abierta."),
    "/short": page("es", "Home page", "Welcome"),
};

describe("localised metadata", () => {
    let server: Server;
    let report: Report;
    let origin: string;

    before(async () => {
        server = createServer((request, response) => {
            const body = PAGES[request.url ?? ""];
            response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body ?? "");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        report = await audit({ seeds: [`${origin}/en`], sitemap: false, rules: ["i18n/metadata-language"], cacheMode: "off", fold: false });
    });
    after(() => server.close());

    // The detected languages of the page at `path`.
    const detected = (path: string) => report.pages.find((facts) => facts.url.href === `${origin}${path}`)?.html?.detected;

    it("fails an es page with an English title and passes matching en, es and uk pages", () => {
        assert.deepEqual(report.findings.map((finding) => [finding.rule, finding.url.slice(origin.length), finding.message]), [["i18n/metadata-language", "/es-mixed", "lang is “es”, but the title reads as en (0.81)"]]);
    });

    it("detects title and description languages above the minimum length only", () => {
        assert.deepEqual([detected("/uk")?.title?.language, detected("/uk")?.description?.language, detected("/es")?.title?.language], ["uk", "uk", "es"]);
        assert.deepEqual(detected("/short"), {});
    });
});
