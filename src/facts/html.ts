// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { CheerioCrawlingContext } from "crawlee";
import { isInScope, type Scope } from "../crawl/scope.ts";
import type { HtmlFacts } from "./types.ts";

// The crawler's own cheerio instance type, so the CJS and ESM typings never split.
type CheerioAPI = CheerioCrawlingContext["$"];

// Only these document types carry html.* facts and links to follow.
export const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);

// First value wins on repeated meta names and og properties.
function firstAttribute($: CheerioAPI, selector: string, key: string): Record<string, string> {
    const out: Record<string, string> = {};
    $(selector).each((_, element) => {
        const name = String($(element).attr(key)).toLowerCase();
        out[name] ??= String($(element).attr("content"));
    });
    return out;
}

// Resolves every href against the page; unparsable ones are dropped.
function hrefs($: CheerioAPI, selector: string, page: URL): URL[] {
    return $(selector)
        .map((_, element) => {
            try {
                return new URL(String($(element).attr("href")), page);
            } catch {
                return;
            }
        })
        .get()
        .filter((url): url is URL => url !== undefined && /^https?:$/.test(url.protocol));
}

// Static HTML facts from the parsed document; the http fetch mode is enough.
export function extractHtml($: CheerioAPI, page: URL, scope: Scope): HtmlFacts {
    const anchors = hrefs($, "a[href]", page).map((url) => url.href);
    return {
        lang: $("html").attr("lang"),
        title: $("head > title").first().text().trim() || undefined,
        h1: $("h1").map((_, element) => $(element).text().trim()).get(),
        canonical: $('link[rel="canonical"]').attr("href"),
        meta: firstAttribute($, "meta[name][content]", "name"),
        property: firstAttribute($, "meta[property][content]", "property"),
        links: {
            internal: [...new Set(anchors.filter((href) => isInScope(new URL(href), page, scope)))],
            external: [...new Set(anchors.filter((href) => !isInScope(new URL(href), page, scope)))],
            nofollow: [...new Set(hrefs($, "a[href][rel~='nofollow']", page).map((url) => url.href))],
        },
        images: $("img")
            .map((_, element) => {
                const alt = $(element).attr("alt");
                return { src: String($(element).attr("src") ?? ""), ...(alt !== undefined && { alt }) };
            })
            .get(),
    };
}
