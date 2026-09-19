// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { CheerioAPI } from "cheerio";
import type { HtmlFacts } from "./types.ts";

// Static HTML facts from the parsed document; the http fetch mode is enough.
export function extractHtml($: CheerioAPI): HtmlFacts {
    const meta: Record<string, string> = {};
    $("meta[name][content]").each((_, element) => {
        meta[String($(element).attr("name")).toLowerCase()] = String($(element).attr("content"));
    });
    return {
        lang: $("html").attr("lang"),
        title: $("head > title").first().text().trim() || undefined,
        h1: $("h1").map((_, element) => $(element).text().trim()).get(),
        canonical: $('link[rel="canonical"]').attr("href"),
        meta,
    };
}
