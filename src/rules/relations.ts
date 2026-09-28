// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import picomatch from "picomatch";
import { ConfigError } from "../config/index.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "./types.ts";

// Internal links carrying `nofollow`, which withholds the site’s own ranking from its pages.
const internalNofollow: Make = (severity) => ({
    meta: { id: "links/internal-nofollow", severity, scope: "page", facts: ["html.links.internal", "html.links.nofollow"], docs: "https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links", fix: "Drop rel=nofollow from links to the site’s own pages; keep robots.txt or noindex for pages crawlers should skip." },
    check(page: Facts) {
        if (!page.html) return;
        const internal = new Set(page.html.links.internal);
        const found = page.html.links.nofollow.filter((href) => internal.has(href));
        log.debug({ rule: "links/internal-nofollow", url: page.url.href, found: found.length }, "internal nofollow checked");
        return found.length === 0 ? [] : [{ rule: "links/internal-nofollow", severity, scope: "page" as const, url: page.url.href, group: page.group, message: `${found.length} internal links carry rel=nofollow: ${found.slice(0, 5).join(", ")}`, value: found }];
    },
});

// The `expect` of `links/external-rel`: host glob → the rel tokens a link to a matching host carries.
function policyOf(expect: unknown): { isMatch: picomatch.Matcher; tokens: string[] }[] {
    const entries = Object.entries((expect ?? {}) as Record<string, unknown>);
    return entries.map(([glob, tokens]) => {
        const list = [tokens].flat();
        if (glob.length === 0 || list.length === 0 || list.some((token) => typeof token !== "string" || !/^[a-z-]+$/.test(token))) throw new ConfigError(`rule links/external-rel: expect ${glob || "\"\""} must name lower-case rel tokens, found ${JSON.stringify(tokens)}`);
        return { isMatch: picomatch(glob, { nocase: true }), tokens: list as string[] };
    });
}

// External links whose host a declared glob matches and that lack a token it requires.
const externalRelation: Make = (severity, expect) => {
    const policy = policyOf(expect);
    return {
        meta: { id: "links/external-rel", severity, scope: "page", facts: ["html.links.external", "html.links.rel"], docs: "https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links", fix: "Add the rel tokens the policy names, as sponsored on paid links and ugc on user content, rather than nofollow on every external link.", expect: expect as Record<string, unknown> | undefined },
        check(page: Facts) {
            if (!page.html || policy.length === 0) return;
            const findings: Finding[] = [];
            for (const href of page.html.links.external) {
                const carried = page.html.links.rel?.[href] ?? [];
                const missing = [...new Set(policy.filter(({ isMatch }) => isMatch(new URL(href).hostname)).flatMap(({ tokens }) => tokens))].filter((token) => !carried.includes(token));
                if (missing.length === 0) continue;
                log.debug({ rule: "links/external-rel", url: page.url.href, href, carried, missing }, "external link lacks declared rel");
                findings.push({ rule: "links/external-rel", severity, scope: "page", url: page.url.href, group: page.group, message: `the link to ${href} lacks rel=${missing.join(" ")} (carries ${carried.join(" ") || "none"})`, value: { href, missing } });
            }
            return findings;
        },
    };
};

export const relationRules: Record<string, Make> = {
    "links/internal-nofollow": internalNofollow,
    "links/external-rel": externalRelation,
};
