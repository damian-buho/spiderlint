// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { Facts, GraphFacts, SiteFacts } from "./types.ts";

const DAMPING = 0.85;
const ROUNDS = 100;
const SETTLED = 1e-9;

// Each page’s distinct internal link targets among the stored pages, a redirect standing for its target, self links dropped.
function edges(pages: Facts[], redirects: Record<string, string>): Map<Facts, Facts[]> {
    const byHref = new Map(pages.map((page) => [page.url.href, page]));
    for (const [from, to] of Object.entries(redirects)) {
        const target = byHref.get(to);
        if (target) byHref.set(from, target);
    }
    return new Map(pages.map((page) => [page, [...new Set((page.html?.links.internal ?? []).map((href) => byHref.get(href)))].filter((target): target is Facts => target !== undefined && target !== page)]));
}

// Fewest links from any seed to each page; a page no link path reaches has none.
function depths(out: Map<Facts, Facts[]>): Map<Facts, number> {
    const seeds = out.keys().filter((page) => page.crawl["discovered-via"] === "seed").toArray();
    const depth = new Map(seeds.map((page) => [page, 0]));
    let frontier = seeds;
    for (let next = 1; frontier.length > 0; next++) {
        const reached = [...new Set(frontier.flatMap((page) => out.get(page) ?? []))].filter((target) => !depth.has(target));
        for (const target of reached) depth.set(target, next);
        frontier = reached;
    }
    return depth;
}

// PageRank over the internal links, a page linking nowhere spreading its rank over every page.
function ranks(out: Map<Facts, Facts[]>): Map<Facts, number> {
    const pages = out.keys().toArray();
    let rank = new Map(pages.map((page) => [page, 1 / pages.length]));
    for (let round = 1; round <= ROUNDS; round++) {
        const dangling = pages.filter((page) => out.get(page)?.length === 0).reduce((sum, page) => sum + (rank.get(page) as number), 0);
        const next = new Map(pages.map((page) => [page, (1 - DAMPING + DAMPING * dangling) / pages.length]));
        for (const [page, targets] of out) {
            for (const target of targets) next.set(target, (next.get(target) as number) + (DAMPING * (rank.get(page) as number)) / targets.length);
        }
        const change = pages.reduce((sum, page) => sum + Math.abs((next.get(page) as number) - (rank.get(page) as number)), 0);
        rank = next;
        if (change < SETTLED) {
            log.debug({ pages: pages.length, round }, "page rank settled");
            break;
        }
    }
    return rank;
}

// Sets each page’s `graph` facts and returns the site’s; recomputed on every lint, `isCapped` when the crawl stopped at a limit.
export function linkGraph(pages: Facts[], redirects: Record<string, string> = {}, isCapped = false): NonNullable<SiteFacts["graph"]> {
    const out = edges(pages, redirects);
    const depth = depths(out);
    const rank = ranks(out);
    const inDegree = new Map<Facts, number>();
    for (const targets of out.values()) for (const target of targets) inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
    for (const page of pages) {
        const linked = new Set((page.html?.links.internal ?? []).filter((href) => href !== page.url.href && href !== page.crawl.requested));
        const graph: GraphFacts = { "in-degree": inDegree.get(page) ?? 0, "out-degree": linked.size, rank: Number(((rank.get(page) ?? 0) * pages.length).toFixed(3)) };
        if (depth.has(page)) graph.depth = depth.get(page);
        page.graph = graph;
    }
    const site = { pages: pages.length, edges: out.values().reduce((sum, targets) => sum + targets.length, 0), ...(isCapped && { capped: true as const }) };
    log.debug({ ...site, unreached: pages.length - depth.size }, "link graph built");
    return site;
}
