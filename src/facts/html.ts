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

// The href resolved against the page, else as written.
function resolve(href: string, page: URL): string {
    try {
        return new URL(href, page).href;
    } catch {
        return href;
    }
}

const LINK_KEYS = ["rel", "type", "hreflang", "sizes", "media", "as", "crossorigin"] as const;

// Every `<link>` in the head with the attributes it carries.
function headLinks($: CheerioAPI, page: URL): HtmlFacts["head"]["links"] {
    return $("head link[href]")
        .map((_, element) => {
            const link: HtmlFacts["head"]["links"][number] = { href: resolve(String($(element).attr("href")), page) };
            for (const key of LINK_KEYS) if ($(element).attr(key) !== undefined) link[key] = String($(element).attr(key));
            return link;
        })
        .get();
}

// Each JSON-LD block parsed; an unparsable one is `{ "@error": message }`.
function jsonld($: CheerioAPI): unknown[] {
    return $('script[type="application/ld+json"]')
        .map((_, element) => {
            try {
                return [JSON.parse($(element).text())];
            } catch (error) {
                return [{ "@error": error instanceof Error ? error.message : String(error) }];
            }
        })
        .get();
}

// Static HTML facts from the parsed document; the http fetch mode is enough.
export function extractHtml($: CheerioAPI, page: URL, scope: Scope): HtmlFacts {
    const anchors = hrefs($, "a[href]", page).map((url) => url.href);
    return {
        lang: $("html").attr("lang"),
        dir: $("html").attr("dir"),
        title: $("head > title").first().text().trim() || undefined,
        h1: $("h1").map((_, element) => $(element).text().trim()).get(),
        canonical: $('link[rel="canonical"]').attr("href"),
        meta: firstAttribute($, "meta[name][content]", "name"),
        property: firstAttribute($, "meta[property][content]", "property"),
        head: { links: headLinks($, page) },
        hreflang: $("link[rel~='alternate'][hreflang][href]").map((_, element) => ({ lang: String($(element).attr("hreflang")), href: resolve(String($(element).attr("href")), page) })).get(),
        jsonld: jsonld($),
        scripts: $("script")
            .map((_, element) => {
                const source = $(element).attr("src");
                const type = $(element).attr("type");
                return { ...(source !== undefined && { src: resolve(source, page) }), ...(type !== undefined && { type }), async: $(element).is("[async]"), defer: $(element).is("[defer]"), head: $(element).closest("head").length > 0 };
            })
            .get(),
        links: {
            internal: [...new Set(anchors.filter((href) => isInScope(new URL(href), page, scope)))],
            external: [...new Set(anchors.filter((href) => !isInScope(new URL(href), page, scope)))],
            nofollow: [...new Set(hrefs($, "a[href][rel~='nofollow']", page).map((url) => url.href))],
        },
        images: $("img")
            .map((_, element) => {
                const [alt, width, height, srcset] = [$(element).attr("alt"), $(element).attr("width"), $(element).attr("height"), $(element).attr("srcset")];
                const isInNoscript = $(element).closest("noscript").length > 0;
                return { src: String($(element).attr("src") ?? ""), ...(alt !== undefined && { alt }), ...(width !== undefined && { width }), ...(height !== undefined && { height }), ...(srcset !== undefined && { srcset }), ...(isInNoscript && { noscript: true as const }) };
            })
            .get(),
    };
}
