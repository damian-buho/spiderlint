// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import type { Facts } from "../facts/types.ts";
import { reason } from "../crawl/fetch.ts";
import { readNote } from "../facts/read-note.ts";
import { log } from "../logger.ts";
import { pageRule } from "../rules/builtin.ts";
import { definePlugin, type PageContext } from "./types.ts";
import { visit, withPage } from "./visit.ts";

const ID = "rel-me-live";
const MAX_PROFILES = 8;

// A profile a rendered page names with `rel=me`, as a browser loaded it.
export interface LiveProfile {
    url: string;
    status?: number;
    back: boolean;
    error?: string;
    // When the browser loaded it, and `cached` when that was an earlier run.
    at?: string;
    cached?: true;
}

// A page script listing the absolute `href` of every `rel=me` link in the rendered DOM.
const ME_LINKS = `[...document.querySelectorAll("a[rel~=me][href], link[rel~=me][href]")].map((element) => element.href)`;

// The URL without its trailing slash and fragment, as a back-link is compared.
function bare(href: string): string {
    const url = new URL(href);
    url.hash = "";
    return url.href.replace(/\/$/, "");
}

// The profiles a rendered page examined, from its `rel-me-live` fact.
export function examined(page: Facts): LiveProfile[] {
    return (page[ID] as { profiles?: LiveProfile[] } | undefined)?.profiles ?? [];
}

// Every profile some page examined, by normalised URL, that answered 2xx: its browser verdict stands in for the static one.
export function judged(pages: readonly Facts[]): Map<string, boolean> {
    const verdicts = new Map<string, boolean>();
    const all = pages.flatMap((page) => examined(page));
    for (const profile of all) {
        if (profile.status === undefined || profile.status < 200 || profile.status > 299) continue;
        verdicts.set(bare(profile.url), (verdicts.get(bare(profile.url)) ?? false) || profile.back);
    }
    return verdicts;
}

// Each external `rel=me` profile of a rendered page, loaded in a browser, and whether the page it renders names this one back with `rel=me`.
const extract = async (page: Facts, _body: string, live?: Page, context?: PageContext): Promise<unknown> => {
    if (!live) return;
    const ours = new Set([bare(`${page.url.origin}/`), bare(page.url.href)]);
    const hrefs = (await live.evaluate(ME_LINKS)) as string[];
    const external = hrefs.filter((href) => URL.canParse(href) && /^https?:$/.test(new URL(href).protocol) && new URL(href).origin !== page.url.origin);
    const targets = [...new Set(external)].slice(0, MAX_PROFILES);
    log.debug({ url: page.url.href, declared: hrefs.length, targets: targets.length }, "rel=me links read from the rendered page");
    if (targets.length === 0) return;
    const profiles: LiveProfile[] = [];
    for (const target of targets) {
        if (context && !(await context.allowed(target))) {
            log.info({ url: page.url.href, target }, "robots.txt disallows the profile; skipped");
            profiles.push({ url: target, back: false, error: "robots.txt disallows it" });
            continue;
        }
        const key = `rel-me-live\t${page.url.href}\t${target}`;
        const entry = await context?.profiles.get(key);
        if (entry && context?.profiles.isFresh(entry)) {
            log.debug({ url: page.url.href, target, stored: entry.stored }, "rel=me profile verdict from the cache");
            profiles.push({ ...(entry.value as LiveProfile), at: entry.stored, cached: true });
            continue;
        }
        const loaded: LiveProfile = await withPage(live, async (fresh): Promise<LiveProfile> => {
            let status: number | undefined;
            fresh.on("response", (response) => {
                if (response.request().isNavigationRequest() && response.frame() === fresh.mainFrame()) status = response.status();
            });
            try {
                await visit(fresh, target);
                const back = ((await fresh.evaluate(ME_LINKS)) as string[]).some((href) => URL.canParse(href) && ours.has(bare(href)));
                log.debug({ url: page.url.href, target, status, back }, "rel=me profile rendered");
                return { url: target, ...(status !== undefined && { status }), back };
            } catch (error) {
                log.debug({ url: page.url.href, target, error: reason(error) }, "rel=me profile not rendered");
                return { url: target, back: false, error: reason(error) };
            }
        });
        const at = new Date().toISOString();
        if (loaded.status !== undefined && !loaded.error) await context?.profiles.set(key, loaded);
        profiles.push({ ...loaded, at });
    }
    return { profiles };
};

const rendered = pageRule("links/rel-me-rendered", [`${ID}.profiles`], (page) => {
    if (page[ID] === undefined) return;
    return examined(page).filter((profile) => !profile.back && profile.status !== undefined && profile.status >= 200 && profile.status <= 299).map((profile) => ({ message: `rel=me profile ${profile.url} does not link back to ${page.url.origin}, even after its scripts ran in a browser${profile.at ? ` (${readNote({ at: profile.at, ...(profile.cached && { cached: profile.cached }) })}; --refresh loads it again)` : ""}`, value: profile.url }));
}, { docs: "https://microformats.org/wiki/rel-me", fix: "Add this site to the profile’s website links, and confirm the profile page shows it to visitors who are not signed in." });

export default definePlugin({
    name: "rel-me",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", cached: false, extract }],
    rules: { "links/rel-me-rendered": rendered },
    presets: {
        "rel-me": {
            description: "Each rel=me profile a page names, loaded in a browser so a link its scripts add counts, and whether it names the page back",
            rules: { "links/rel-me-rendered": { severity: "info", score: 2.2 } },
        },
    },
});
