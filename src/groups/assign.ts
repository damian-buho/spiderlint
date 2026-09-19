// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";

// Every page is `default` until glob and regex groups exist.
export function assignGroup(facts: Facts): string {
    const group = "default";
    log.debug({ url: facts.url.href, group }, "group assigned");
    return group;
}
