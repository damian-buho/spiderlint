// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import anyAscii from "any-ascii";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "./types.ts";

// A slug that is only an identifier: digits, a hex run with a digit, or a UUID.
const ID_ONLY = /^(?:\d+|(?=[a-f]*\d)[\da-f]{6,}|[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})$/i;
// A last segment naming a file by its extension.
const FILE = /\.[a-z\d]{1,5}$/i;

// Lower-case ASCII word tokens of `text`, in any script, percent-decoded.
export function tokens(text: string): Set<string> {
    let decoded = text;
    try {
        decoded = decodeURIComponent(text);
    } catch {
        log.debug({ text }, "slug not percent-decodable");
    }
    return new Set(
        anyAscii(decoded.normalize("NFKC"))
            .toLowerCase()
            .split(/[^a-z\d]+/)
            .filter((token) => token.length > 0),
    );
}

// The last non-empty path segment without its extension; empty for the root.
function slugOf(page: Facts): string {
    return (page.url.pathname.split("/").findLast((segment) => segment.length > 0) ?? "").replace(FILE, "");
}

// A slug that is an identifier or shares no word with the page’s title or first heading.
const readableSlug: Make = (severity) => ({
    meta: { id: "url/readable-slug", severity, scope: "page", facts: ["url.pathname", "html.title", "html.h1"], docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure", fix: "Name the page in its URL with words from its title, as /spring-recipes for “Spring recipes”." },
    check(page: Facts) {
        const slug = slugOf(page);
        const heading = [page.html?.title ?? "", ...(page.html?.h1 ?? [])].join(" ");
        if (!slug || !heading.trim()) return;
        const isId = ID_ONLY.test(slug);
        const shared = tokens(slug).intersection(tokens(heading)).size;
        log.debug({ rule: "url/readable-slug", url: page.url.href, slug, isId, shared }, "slug read against the title");
        if (!isId && shared > 0) return [];
        const message = isId ? `the slug ${slug} is an identifier, not words` : `the slug ${slug} shares no word with the title “${page.html?.title ?? page.html?.h1[0]}”`;
        return [{ rule: "url/readable-slug", severity, scope: "page" as const, url: page.url.href, group: page.group, message, value: slug }];
    },
});

// A site finding naming the majority form and every page in the minority, when both forms appear.
function minority(id: string, severity: Finding["severity"], label: string, forms: Map<string, Facts[]>): Finding | undefined {
    const ranked = forms
        .entries()
        .toArray()
        .toSorted(([, a], [, b]) => b.length - a.length);
    const [[major, most] = ["", []], ...rest] = ranked;
    const urls = rest.flatMap(([, pages]) => pages.map((page) => page.url.href));
    log.debug({ rule: id, label, major, most: most.length, minor: urls.length }, "url forms counted");
    return urls.length === 0 ? undefined : { rule: id, severity, scope: "site", url: urls[0] as string, message: `${label}: ${most.length} pages ${major}, ${urls.length} ${rest.map(([form]) => form).join(", ")}`, value: Object.fromEntries(ranked.map(([form, pages]) => [form, pages.length])), urls };
}

// Pages whose words join with the separator fewer pages of the site use.
const separators: Make = (severity) => ({
    meta: { id: "url/separators", severity, scope: "site", facts: ["url.pathname"], docs: "https://developers.google.com/search/docs/crawling-indexing/url-structure", fix: "Join the words of every URL with hyphens, and redirect the others to them." },
    check(pages: Facts[]) {
        const forms = new Map<string, Facts[]>();
        for (const page of pages) {
            const path = page.url.pathname.replace(FILE, "");
            const form = /\w_\w/.test(path) ? (/\w-\w/.test(path) ? "mixed" : "use _") : /\w-\w/.test(path) ? "use -" : undefined;
            if (form) forms.set(form, [...(forms.get(form) ?? []), page]);
        }
        const finding = minority("url/separators", severity, "word separators differ", forms);
        return finding ? [finding] : [];
    },
});

// Per group, pages whose trailing slash differs from the group’s usual form; the root and file names are left out.
const trailingSlash: Make = (severity) => ({
    meta: { id: "url/trailing-slash", severity, scope: "site", facts: ["url.pathname"], docs: "https://developers.google.com/search/blog/2010/04/to-slash-or-not-to-slash", fix: "Pick one form, with or without the trailing slash, and redirect the other to it." },
    check(pages: Facts[]) {
        const judged = pages.filter((page) => page.url.pathname !== "/" && !FILE.test(page.url.pathname));
        return Map.groupBy(judged, (page) => page.group)
            .entries()
            .map(([group, members]) =>
                minority(
                    "url/trailing-slash",
                    severity,
                    `trailing slashes differ in group ${group}`,
                    Map.groupBy(members, (page) => (page.url.pathname.endsWith("/") ? "with /" : "without /")),
                ),
            )
            .filter((finding) => finding !== undefined)
            .toArray();
    },
});

export const urlRules: Record<string, Make> = {
    "url/readable-slug": readableSlug,
    "url/separators": separators,
    "url/trailing-slash": trailingSlash,
};
