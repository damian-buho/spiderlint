// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";

// Stream-mode store: facts only, nothing persisted; one record per final URL.
export class MemoryStore {
    readonly #seen = new Set<string>();
    readonly pages: Facts[] = [];

    add(facts: Facts): boolean {
        if (this.#seen.has(facts.url.href)) {
            log.debug({ url: facts.url.href }, "page already stored");
            return false;
        }
        this.#seen.add(facts.url.href);
        this.pages.push(facts);
        return true;
    }
}
