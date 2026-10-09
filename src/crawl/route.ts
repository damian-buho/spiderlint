// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as sleep } from "node:timers/promises";
import type { GroupConfig } from "../config/index.ts";
import type { Facts, HtmlFacts } from "../facts/types.ts";
import { assignGroup, compileGroups } from "../groups/assign.ts";
import { log } from "../logger.ts";

export type CrawlerMode = "http" | "browser";
export type GroupMode = CrawlerMode | "adaptive";

// Pages of an adaptive group rendered and compared with their static HTML before it settles on http.
const DETECTIONS = 3;
// Milliseconds a page of an undecided group waits for the verdict before the group settles on the browser.
const VERDICT_MS = 60_000;

// The html facts a client-side render can change and a rule or the crawl reads.
function rendered(html: HtmlFacts | undefined): string {
    const { title, lang, canonical, h1 = [], meta = {}, property = {}, links } = html ?? {};
    return JSON.stringify({ title, lang, canonical, h1, meta, property, internal: links?.internal.toSorted((a, b) => a.localeCompare(b)) });
}

// Routes each URL to the crawler its group needs; an adaptive group renders until its pages read the same without a browser.
export class Router {
    readonly #groups: ReturnType<typeof compileGroups>;
    readonly #modes: Map<string, GroupMode>;
    readonly #agreed = new Map<string, number>();
    readonly #taken = new Map<string, number>();
    readonly #verdicts = new Map<string, PromiseWithResolvers<void>>();

    constructor(groups: Record<string, GroupConfig>, modes: Record<string, GroupMode>) {
        this.#groups = compileGroups(groups);
        this.#modes = new Map(Object.entries(modes));
    }

    // The group a URL falls in before its response is known, so `content-type:` entries never match.
    #groupOf(href: string): string {
        const url = new URL(href);
        return assignGroup({ url: { href, pathname: url.pathname, search: url.search }, http: { headers: {} } } as unknown as Facts, this.#groups);
    }

    // A group’s mode, http for one the config never named.
    #modeOf(group: string): GroupMode {
        return this.#modes.get(group) ?? "http";
    }

    // Resolves once `group` settles.
    #verdict(group: string): PromiseWithResolvers<void> {
        const known = this.#verdicts.get(group) ?? Promise.withResolvers<void>();
        this.#verdicts.set(group, known);
        return known;
    }

    // Fixes `group` on `mode` and wakes every page waiting for its verdict.
    #settle(group: string, mode: CrawlerMode, agreed: number): void {
        this.#modes.set(group, mode);
        this.#verdict(group).resolve();
        log.debug({ group, fetch: mode, agreed }, "adaptive group settled");
    }

    // Crawlers the run needs: an adaptive group needs both.
    get crawlers(): CrawlerMode[] {
        const modes = new Set(this.#modes.values());
        return (["http", "browser"] as const).filter((mode) => modes.has(mode) || modes.has("adaptive"));
    }

    // Each group’s mode, adaptive ones as settled so far.
    get modes(): Record<string, GroupMode> {
        return Object.fromEntries(this.#modes);
    }

    // The queue `href` joins: the browser’s for a group that renders, else http’s, where an adaptive group is decided per request.
    queue(href: string): CrawlerMode {
        return this.#modeOf(this.#groupOf(href)) === "browser" ? "browser" : "http";
    }

    // Whether the http crawler hands `href` to the browser: its group renders, or is undecided and has a detection slot; past the slots it waits for the verdict.
    async handOff(href: string): Promise<boolean> {
        const group = this.#groupOf(href);
        const taken = this.#taken.get(group) ?? 0;
        const isSlot = this.#modeOf(group) === "adaptive" && taken < DETECTIONS;
        if (isSlot) this.#taken.set(group, taken + 1);
        if (!isSlot && this.#modeOf(group) === "adaptive") await Promise.race([this.#verdict(group).promise, sleep(VERDICT_MS, undefined, { ref: false })]);
        if (!isSlot && this.#modeOf(group) === "adaptive") this.#settle(group, "browser", this.#agreed.get(group) ?? 0);
        log.debug({ url: href, group, mode: this.#modeOf(group), taken, isSlot }, "hand-off decided");
        return isSlot || this.#modeOf(group) !== "http";
    }

    // Whether a rendered page is to be compared with its static HTML, its group being still undecided.
    isDetecting(href: string): boolean {
        return this.#modeOf(this.#groupOf(href)) === "adaptive";
    }

    // One difference settles the group on the browser, DETECTIONS agreements on http; a page without html facts agrees.
    detected(href: string, stat: HtmlFacts | undefined, live: HtmlFacts | undefined): void {
        const group = this.#groupOf(href);
        if (this.#modeOf(group) !== "adaptive") return;
        const isSame = rendered(stat) === rendered(live);
        const agreed = (this.#agreed.get(group) ?? 0) + (isSame ? 1 : 0);
        this.#agreed.set(group, agreed);
        const settled = isSame ? (agreed >= DETECTIONS ? "http" : undefined) : "browser";
        log.debug({ url: href, group, isSame, agreed, settled }, "rendering compared");
        if (settled) this.#settle(group, settled, agreed);
    }
}
