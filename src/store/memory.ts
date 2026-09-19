// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";

// Stream-mode store: facts only, nothing persisted.
export class MemoryStore {
    readonly pages: Facts[] = [];

    add(facts: Facts): void {
        this.pages.push(facts);
    }
}
