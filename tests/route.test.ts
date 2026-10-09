// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/crawl/route.ts";
import type { HtmlFacts } from "../src/facts/types.ts";

const GROUPS = { app: { match: ["/app/**"] }, posts: { match: ["/posts/**"] }, default: {} };
const ORIGIN = "https://a.test";

// Html facts carrying `title`, the one field these tests vary.
function titled(title: string): HtmlFacts {
    return { title, h1: [], meta: {}, property: {}, links: { internal: [], external: [], nofollow: [] } } as unknown as HtmlFacts;
}

describe("router", () => {
    it("queues a rendering group on the browser and every other on http, needing only the crawlers its groups use", () => {
        const router = new Router(GROUPS, { app: "browser", posts: "http", default: "http" });
        assert.deepEqual([router.queue(`${ORIGIN}/app/x`), router.queue(`${ORIGIN}/posts/1`), router.queue(`${ORIGIN}/`)], ["browser", "http", "http"]);
        assert.deepEqual(router.crawlers, ["http", "browser"]);
        assert.deepEqual(new Router(GROUPS, { app: "http", posts: "http", default: "http" }).crawlers, ["http"]);
        assert.deepEqual(new Router(GROUPS, { app: "adaptive", posts: "http", default: "http" }).crawlers, ["http", "browser"]);
    });

    it("renders three pages of an adaptive group, holds the rest for the verdict, and settles on http when they agree", async () => {
        const router = new Router(GROUPS, { app: "http", posts: "adaptive", default: "http" });
        const slots = await Promise.all([1, 2, 3].map((index) => router.handOff(`${ORIGIN}/posts/${index}`)));
        assert.deepEqual(slots, [true, true, true]);
        const held = router.handOff(`${ORIGIN}/posts/4`);
        for (const index of [1, 2, 3]) router.detected(`${ORIGIN}/posts/${index}`, titled("same"), titled("same"));
        assert.equal(await held, false);
        assert.equal(router.modes.posts, "http");
        assert.equal(router.isDetecting(`${ORIGIN}/posts/5`), false);
    });

    it("settles on the browser at the first page rendering changes", async () => {
        const router = new Router(GROUPS, { app: "adaptive", posts: "http", default: "http" });
        assert.equal(await router.handOff(`${ORIGIN}/app/1`), true);
        router.detected(`${ORIGIN}/app/1`, titled(""), titled("Rendered"));
        assert.equal(router.modes.app, "browser");
        assert.equal(router.queue(`${ORIGIN}/app/2`), "browser");
        assert.equal(await router.handOff(`${ORIGIN}/posts/1`), false);
    });
});
