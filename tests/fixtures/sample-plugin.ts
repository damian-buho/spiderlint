// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts } from "../../src/facts/types.ts";
import { definePlugin } from "../../src/plugins/types.ts";

// A cheap body length and an expensive marker, each failing its rule on every HTML page.
export default definePlugin({
    name: "fixture-sample",
    extractors: [
        { id: "length", extract: async (page: Facts, body: string) => (page.html ? { bytes: body.length } : undefined) },
        { id: "heavy", cost: "expensive", extract: async (page: Facts) => (page.html ? { ran: true } : undefined) },
    ],
    rules: {
        "heavy/ran": (severity) => ({
            meta: { id: "heavy/ran", severity, scope: "page", facts: ["heavy.ran", "length.bytes"] },
            check: (page: Facts) => (page.heavy ? [{ rule: "heavy/ran", severity, scope: "page" as const, url: page.url.href, group: page.group, message: "heavy ran" }] : undefined),
        }),
    },
    presets: { heavy: { description: "Expensive fixture extractor", rules: { "heavy/ran": "warning" } } },
});
