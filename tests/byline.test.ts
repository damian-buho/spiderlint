// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bylineFacts } from "../src/facts/byline.ts";
import type { HtmlFacts } from "../src/facts/types.ts";

// The head facts the byline reads, the rest left empty.
const html = (jsonld: unknown[], meta: Record<string, string> = {}, property: Record<string, string> = {}) => ({ jsonld, meta, property }) as HtmlFacts;

describe("byline", () => {
    it("prefers a JSON-LD author and date inside @graph over the head tags", () => {
        const graph = [{ "@graph": [{ "@type": "WebSite" }, { "@type": "BlogPosting", author: [{ "@type": "Person", name: "Ada" }], datePublished: "2026-09-01" }] }];
        assert.deepEqual(bylineFacts(html(graph, { author: "Head" }, { "article:published_time": "2026-01-01" })), { author: "Ada", published: "2026-09-01" });
    });

    it("falls back to article:author, then meta author, and drops a blank value", () => {
        assert.deepEqual(bylineFacts(html([], { author: "Head" }, { "article:author": "https://example.com/ada" })), { author: "https://example.com/ada" });
        assert.deepEqual(bylineFacts(html([], { author: "Head" })), { author: "Head" });
        assert.deepEqual(bylineFacts(html([{ "@error": "bad" }], { author: " " }, { "article:published_time": "" })), {});
    });
});
