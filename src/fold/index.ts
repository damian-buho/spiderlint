// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { Finding } from "../rules/types.ts";

// Identity until saturation folding exists.
export function fold(findings: Finding[]): Finding[] {
    log.debug({ before: findings.length, after: findings.length }, "fold");
    return findings;
}
