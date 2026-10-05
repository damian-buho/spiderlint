// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";

// Directory names kept apart per level; later names share one wildcard child.
const FANOUT = 32;
const WILDCARD = "*";

export interface Candidate {
    url: string;
    crawlDepth: number;
}

// Pooled candidates in arrival order.
class Bucket {
    #items: Candidate[] = [];
    #head = 0;

    get size(): number {
        return this.#items.length - this.#head;
    }

    push(candidate: Candidate): void {
        this.#items.push(candidate);
    }

    // The oldest candidate; the array is compacted once half of it is spent.
    shift(): Candidate {
        const candidate = this.#items[this.#head] as Candidate;
        this.#head += 1;
        if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
            this.#items = this.#items.slice(this.#head);
            this.#head = 0;
        }
        return candidate;
    }
}

// One directory of the URL tree: its own pages, its subdirectories, and how much of the budget each took.
class Directory {
    readonly children = new Map<string, Directory>();
    readonly leaves = new Bucket();
    // Pages scheduled from this subtree, and from its own pages alone.
    taken = 0;
    leafTaken = 0;
    // Distinct pages this directory itself has held.
    leafCount = 0;
    // Candidates still pooled in this subtree.
    pooled = 0;
}

// The URL without its fragment, which names the same page.
function keyOf(href: string): string {
    const url = new URL(href);
    url.hash = "";
    return url.href;
}

// Candidates pooled by directory; each pick descends to the least-scheduled child, so a budget spreads over the site’s sections before it deepens one.
export class Spread {
    readonly #root = new Directory();
    readonly #known = new Set<string>();
    readonly #pooled = new Map<string, Candidate>();
    readonly #limit: number;

    // `limit` caps one directory’s pooled pages: a budget never takes more than that from it.
    constructor(limit: number) {
        this.#limit = limit;
    }

    // The directories `href` sits under, host first, created on the way.
    #walk(href: string): Directory[] {
        const url = new URL(href);
        const names = [url.host, ...url.pathname.split("/").filter(Boolean).slice(0, -1)];
        const path: Directory[] = [];
        let node = this.#root;
        for (const name of names) {
            const key = node.children.has(name) || node.children.size < FANOUT ? name : WILDCARD;
            const next = node.children.get(key) ?? new Directory();
            node.children.set(key, next);
            path.push(next);
            node = next;
        }
        return path;
    }

    // The next candidate: at each level the child, or the directory’s own pages, with the smallest share of the budget so far.
    #pick(): Candidate {
        const path: Directory[] = [];
        let node = this.#root;
        for (;;) {
            let next: Directory | undefined;
            let least = node.leaves.size > 0 ? node.leafTaken / Math.min(node.leafCount, FANOUT) : Infinity;
            for (const child of node.children.values()) {
                if (child.pooled === 0 || child.taken >= least) continue;
                next = child;
                least = child.taken;
            }
            if (!next) break;
            path.push(next);
            node = next;
        }
        const candidate = node.leaves.shift();
        this.#pooled.delete(keyOf(candidate.url));
        node.leafTaken += 1;
        for (const directory of path) {
            directory.taken += 1;
            directory.pooled -= 1;
        }
        this.#root.pooled -= 1;
        return candidate;
    }

    get size(): number {
        return this.#root.pooled;
    }

    // Counts a page scheduled elsewhere, so the pool favours what it has not covered; false for one already known.
    note(href: string): boolean {
        const key = keyOf(href);
        if (this.#known.has(key)) return false;
        this.#known.add(key);
        const path = this.#walk(href);
        for (const directory of path) directory.taken += 1;
        const holder = path.at(-1) as Directory;
        holder.leafTaken += 1;
        holder.leafCount += 1;
        return true;
    }

    // Pools a candidate; false for one already known or past its directory’s limit.
    add(candidate: Candidate): boolean {
        const key = keyOf(candidate.url);
        if (this.#known.has(key)) return false;
        const path = this.#walk(candidate.url);
        const holder = path.at(-1) as Directory;
        if (holder.leaves.size >= this.#limit) {
            log.debug({ url: candidate.url, limit: this.#limit }, "candidate dropped, directory full");
            return false;
        }
        this.#known.add(key);
        holder.leaves.push(candidate);
        this.#pooled.set(key, candidate);
        holder.leafCount += 1;
        for (const directory of path) directory.pooled += 1;
        this.#root.pooled += 1;
        return true;
    }

    // Gives a pooled candidate that no link has reached the depth of the page linking to it; true when it did.
    relink(url: string, crawlDepth: number): boolean {
        const pooled = this.#pooled.get(keyOf(url));
        if (!pooled || pooled.crawlDepth > 0) return false;
        pooled.crawlDepth = crawlDepth;
        return true;
    }

    // Up to `count` candidates, each from the least-scheduled directory at every level.
    take(count: number): Candidate[] {
        const taken: Candidate[] = [];
        while (taken.length < count && this.#root.pooled > 0) taken.push(this.#pick());
        log.debug({ requested: count, taken: taken.length, pooled: this.#root.pooled }, "candidates taken");
        return taken;
    }
}
