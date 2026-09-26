// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resolve } from "./builtin.ts";
import type { Finding, Make } from "./types.ts";

// The fragment-free hreflang targets of a page other than itself, `x-default` included.
function alternatesOf(page: Facts): string[] {
    const here = selves(page);
    return [...new Set((page.html?.hreflang ?? []).map((alternate) => resolve(alternate.href, page.url.href)))].filter((href) => !here.has(href));
}

// Every URL a page answers to: its own, the one it was requested as and its twin on the canonical origin.
function selves(page: Facts): Set<string> {
    return new Set([page.url.href, page.crawl.requested, page.url.twin].flatMap((href) => (href ? [resolve(href, href)] : [])));
}

// Whether a page answered 2xx.
function isOk(page: Facts): boolean {
    return page.http.status >= 200 && page.http.status < 300;
}

// The crawled 2xx page behind a URL, through its twin and through a redirect.
function pageIndex(pages: Facts[], site?: SiteFacts): (href: string) => Facts | undefined {
    const index = new Map<string, Facts>();
    for (const page of pages) if (isOk(page)) for (const href of selves(page)) index.set(href, page);
    return (href) => index.get(href) ?? index.get(site?.redirects?.[href] ?? "");
}

// The primary language subtag, lower-cased.
function primary(tag: string): string {
    return tag.trim().split("-", 1)[0]?.toLowerCase() ?? "";
}

// Every crawled 2xx alternate that does not name back the 2xx pages listing it, once per alternate.
const hreflangReciprocal: Make = (severity) => ({
    meta: { id: "i18n/hreflang-reciprocal", severity, scope: "site", facts: ["html.hreflang", "site.redirects"], docs: "https://developers.google.com/search/docs/specialty/international/localized-versions#html", fix: "List every language version, itself included, in the hreflang links of each version." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const find = pageIndex(pages, site);
        const unanswered = new Map<string, string[]>();
        for (const page of pages) {
            if (!isOk(page)) continue;
            for (const href of alternatesOf(page)) {
                const alternate = find(href);
                const isNamedBack = alternate === undefined || alternatesOf(alternate).some((back) => selves(page).has(back));
                log.debug({ rule: "i18n/hreflang-reciprocal", url: page.url.href, alternate: href, isCrawled: alternate !== undefined, isNamedBack }, "hreflang alternate judged");
                if (!isNamedBack) unanswered.set(alternate.url.href, [...(unanswered.get(alternate.url.href) ?? []), page.url.href]);
            }
        }
        return unanswered.entries().map(([url, urls]): Finding => ({ rule: "i18n/hreflang-reciprocal", severity, scope: "site", url, message: `does not name back ${urls.length} page${urls.length === 1 ? "" : "s"} listing it as an hreflang alternate`, value: urls, urls })).toArray();
    },
});

// Every crawled hreflang target answering outside 2xx or redirecting, once per target, with the pages naming it.
const hreflangStatus: Make = (severity) => ({
    meta: { id: "i18n/hreflang-status", severity, scope: "site", facts: ["html.hreflang", "http.status", "site.redirects"], docs: "https://developers.google.com/search/docs/specialty/international/localized-versions#html", fix: "Point each hreflang link at the final URL of a page that answers 200." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const status = new Map(pages.flatMap((page) => [...selves(page)].map((href) => [href, page.http.status] as const)));
        const naming = new Map<string, string[]>();
        for (const page of pages) for (const href of alternatesOf(page)) naming.set(href, [...(naming.get(href) ?? []), page.url.href]);
        const findings: Finding[] = [];
        for (const [url, urls] of naming) {
            const [answer, landing] = [status.get(url), site?.redirects?.[url]];
            log.debug({ rule: "i18n/hreflang-status", url, status: answer, landing, pages: urls.length }, "hreflang target judged");
            const verdict = landing ? `redirects to ${landing}` : answer !== undefined && (answer < 200 || answer > 299) ? `answers ${answer}` : undefined;
            if (verdict) findings.push({ rule: "i18n/hreflang-status", severity, scope: "site", url, message: `hreflang target ${verdict}; named by ${urls.length} page${urls.length === 1 ? "" : "s"}`, value: landing ?? answer, urls });
        }
        return findings;
    },
});

// A page whose `lang` names a language its `Content-Language` header leaves out; a page lacking either is skipped.
const contentLanguage: Make = (severity) => ({
    meta: { id: "i18n/content-language", severity, scope: "page", facts: ["html.lang", "http.headers.content-language"], docs: "https://www.w3.org/International/questions/qa-http-and-lang", fix: "Make the Content-Language header name the language the html lang attribute declares, or drop the header." },
    check(page: Facts) {
        const [lang, header] = [page.html?.lang, [page.http.headers["content-language"] ?? []].flat().join(",")];
        if (!lang || header === "") return;
        const languages = header.split(",").map((tag) => primary(tag));
        const isListed = languages.includes(primary(lang));
        log.debug({ rule: "i18n/content-language", url: page.url.href, lang, languages, isListed }, "content language compared");
        return isListed ? [] : [{ rule: "i18n/content-language", severity, scope: "page" as const, url: page.url.href, group: page.group, message: `lang is “${lang}”, Content-Language is “${header}”`, value: header }];
    },
});

export const i18nRules: Record<string, Make> = {
    "i18n/hreflang-reciprocal": hreflangReciprocal,
    "i18n/hreflang-status": hreflangStatus,
    "i18n/content-language": contentLanguage,
};
