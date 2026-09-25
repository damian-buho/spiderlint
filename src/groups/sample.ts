// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { GroupConfig } from "../config/index.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Extractor } from "../plugins/types.ts";
import { assignGroup, compileGroups } from "./assign.ts";

export const SAMPLE_DEFAULT = 3;

// Slots per (group, expensive extractor), capped by the group’s `sample`; cheap extractors are never counted.
export class Sampler {
    readonly #groups: ReturnType<typeof compileGroups>;
    readonly #caps: Map<string, number>;
    readonly #taken = new Map<string, number>();

    constructor(groups: Record<string, GroupConfig>) {
        this.#groups = compileGroups(groups);
        this.#caps = new Map(Object.entries(groups).map(([name, group]) => [name, group.sample === "all" ? Infinity : (group.sample ?? SAMPLE_DEFAULT)]));
    }

    #key(group: string, id: string): string {
        return `${group}\t${id}`;
    }

    groupOf(page: Facts): string {
        return assignGroup(page, this.#groups);
    }

    // The cap of `group`; Infinity for `sample: all`.
    cap(group: string): number {
        return this.#caps.get(group) ?? SAMPLE_DEFAULT;
    }

    // Counts a page that already carries `id`’s facts.
    seed(page: Facts, id: string): void {
        const key = this.#key(this.groupOf(page), id);
        this.#taken.set(key, (this.#taken.get(key) ?? 0) + 1);
    }

    // Every cheap extractor, and each expensive one while `page`’s group has a slot left, which it reserves.
    take(page: Facts, active: Extractor[]): Extractor[] {
        const group = this.groupOf(page);
        const cap = this.cap(group);
        return active.filter((extractor) => {
            if (extractor.cost !== "expensive") return true;
            const key = this.#key(group, extractor.id);
            const taken = this.#taken.get(key) ?? 0;
            const isTaken = taken < cap;
            log.debug({ url: page.url.href, group, extractor: extractor.id, taken, cap, isTaken }, "sampling");
            if (isTaken) this.#taken.set(key, taken + 1);
            return isTaken;
        });
    }

    // Frees the slot of each expensive extractor in `chosen` that added no facts.
    release(page: Facts, chosen: Extractor[], added: string[]): void {
        const group = this.groupOf(page);
        const unused = chosen.filter((extractor) => extractor.cost === "expensive" && !added.includes(extractor.id));
        for (const extractor of unused) this.#taken.set(this.#key(group, extractor.id), (this.#taken.get(this.#key(group, extractor.id)) ?? 1) - 1);
    }
}
