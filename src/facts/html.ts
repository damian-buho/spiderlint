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

// Every `<meta name>` in order, so a repeated name keeps each `media` variant.
function metas($: CheerioAPI): HtmlFacts["metas"] {
    return $("meta[name][content]")
        .map((_, element) => {
            const media = $(element).attr("media");
            return { name: String($(element).attr("name")).toLowerCase(), content: String($(element).attr("content")), ...(media !== undefined && { media }) };
        })
        .get();
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

// Rel tokens every `<a>` to an href carries, for hrefs whose every anchor carries one.
function anchorRels($: CheerioAPI, page: URL): Record<string, string[]> {
    const found = new Map<string, string[]>();
    for (const element of $("a[href]")) {
        const href = resolve(String($(element).attr("href")), page);
        const tokens = String($(element).attr("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        found.set(href, (found.get(href) ?? tokens).filter((token) => tokens.includes(token)));
    }
    return Object.fromEntries([...found].filter(([href, tokens]) => tokens.length > 0 && /^https?:/.test(href)));
}

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

// Hrefs per rel token, over `<a>`, `<area>` and `<link>`.
function rels($: CheerioAPI, page: URL): HtmlFacts["rels"] {
    const found: Record<string, Set<string>> = {};
    for (const element of $("a[rel][href], area[rel][href], link[rel][href]")) {
        const href = resolve(String($(element).attr("href")), page);
        const tokens = String($(element).attr("rel")).toLowerCase().split(/\s+/);
        for (const token of tokens) if (token) (found[token] ??= new Set()).add(href);
    }
    return Object.fromEntries(Object.entries(found).map(([token, hrefs]) => [token, [...hrefs]]));
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

const CHARSET = /<meta\s[^>]*?charset\s*=\s*["']?\s*([^\s"';>]+)[^>]*>/i;

// The first `<meta>` declaring an encoding, with the byte offset where that element ends.
function charsetOf(body: string): HtmlFacts["charset"] {
    const match = CHARSET.exec(body);
    return match?.[1] ? { declared: match[1], offset: Buffer.byteLength(body.slice(0, match.index + match[0].length)) } : undefined;
}

// Static HTML facts from the parsed document and its source; the http fetch mode is enough.
export function extractHtml($: CheerioAPI, body: string, page: URL, scope: Scope): HtmlFacts {
    const anchors = hrefs($, "a[href]", page).map((url) => url.href);
    return {
        lang: $("html").attr("lang"),
        dir: $("html").attr("dir"),
        charset: charsetOf(body),
        title: $("head > title").first().text().trim() || undefined,
        h1: $("h1").map((_, element) => $(element).text().trim()).get(),
        canonical: $('link[rel="canonical"]').attr("href"),
        meta: firstAttribute($, "meta[name][content]", "name"),
        metas: metas($),
        "http-equiv": $("head meta[http-equiv][content]").map((_, element) => ({ name: String($(element).attr("http-equiv")).toLowerCase(), content: String($(element).attr("content")) })).get(),
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
            sponsored: [...new Set(hrefs($, "a[href][rel~='sponsored']", page).map((url) => url.href))],
            ugc: [...new Set(hrefs($, "a[href][rel~='ugc']", page).map((url) => url.href))],
            rel: anchorRels($, page),
        },
        images: $("img")
            .map((_, element) => {
                const [alt, width, height, srcset, loading] = [$(element).attr("alt"), $(element).attr("width"), $(element).attr("height"), $(element).attr("srcset"), $(element).attr("loading")];
                const isInNoscript = $(element).closest("noscript").length > 0;
                return { src: String($(element).attr("src") ?? ""), ...(alt !== undefined && { alt }), ...(width !== undefined && { width }), ...(height !== undefined && { height }), ...(srcset !== undefined && { srcset }), ...(loading !== undefined && { loading }), ...(isInNoscript && { noscript: true as const }) };
            })
            .get(),
        rels: rels($, page),
        inputs: $("input")
            .map((_, element) => {
                const [autocomplete, inputmode] = [$(element).attr("autocomplete"), $(element).attr("inputmode")];
                return { type: String($(element).attr("type") ?? "text").toLowerCase(), ...(autocomplete !== undefined && { autocomplete }), ...(inputmode !== undefined && { inputmode }) };
            })
            .get(),
    };
}
