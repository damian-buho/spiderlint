// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../../src/facts/types.ts";
import { definePlugin } from "../../src/plugins/types.ts";

// Counts the words of a page body; the rule wants at least ten.
export default definePlugin({
    name: "fixture-words",
    extractors: [{ id: "words", extract: async (_page: Facts, body: string) => ({ count: body.split(/\s+/).filter(Boolean).length }) }],
    rules: {
        "words/enough": (severity) => ({
            meta: { id: "words/enough", severity, scope: "page", facts: ["words.count"] },
            check: (page: Facts) => {
                const words = page.words as { count: number } | undefined;
                if (!words) return;
                return words.count >= 10 ? [] : [{ rule: "words/enough", severity, scope: "page" as const, url: page.url.href, group: page.group, message: `${words.count} words`, value: words.count }];
            },
        }),
    },
    presets: { words: { description: "Word count", rules: { "words/enough": "warning" } } },
});
