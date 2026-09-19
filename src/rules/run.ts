// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Rule } from "./types.ts";

// Runs every rule over every page; no rule ships yet.
export function runRules(pages: Facts[], rules: Rule[]): Finding[] {
    const findings: Finding[] = [];
    for (const rule of rules) {
        const found = rule.check(pages);
        log.debug({ rule: rule.meta.id, pages: pages.length, findings: found.length }, "rule ran");
        findings.push(...found);
    }
    return findings;
}
