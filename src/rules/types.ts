// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";

export type Severity = "error" | "warning" | "info" | "off";
export type Scope = "page" | "group" | "site";

export interface Finding {
    rule: string;
    severity: Severity;
    url: string;
    group: string;
    message: string;
    occurrences?: number;
}

export interface Rule {
    meta: { id: string; severity: Severity; scope: Scope; facts: string[] };
    check(pages: Facts[]): Finding[];
}
