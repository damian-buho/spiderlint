// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { definePlugin } from "../../src/plugins/types.ts";

// The `paths` format lists the crawled paths; the `pair` source yields two pages of the origin it is given and follows their links.
export default definePlugin({
    name: "fixture-output",
    formatters: {
        paths: (report) =>
            report.pages
                .map((page) => page.url.pathname)
                .toSorted((left, right) => left.localeCompare(right))
                .join("\n"),
    },
    sources: [{ id: "pair", urls: async (origin) => [`${origin}/about`, `${origin}/orphan`] }],
});
