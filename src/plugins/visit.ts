// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import { reason } from "../crawl/fetch.ts";
import { log } from "../logger.ts";

// Milliseconds a fresh page may take to load, then to fall quiet.
const LOAD_MS = 30_000;
const QUIET_MS = 5000;

// A page script defining `describe(element)`: a short CSS path and the opening tag, as locations print them.
export const DESCRIBE = `function describe(element) {
    const parts = [];
    for (let node = element; node && parts.length < 4; node = node.parentElement) {
        if (node.id) { parts.unshift("#" + CSS.escape(node.id)); break; }
        const same = node.parentElement ? [...node.parentElement.children].filter((sibling) => sibling.localName === node.localName) : [];
        parts.unshift(same.length > 1 ? node.localName + ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : node.localName);
        if (node.localName === "body") break;
    }
    const tag = /^<[^>]*>/.exec(element.outerHTML)?.[0] ?? element.localName;
    return { target: parts.join(" > "), html: tag.length > 120 ? tag.slice(0, 120) + "…" : tag };
}`;

// Loads `url` and waits for its network to fall quiet, reading it anyway once QUIET_MS pass.
export async function visit(page: Page, url: string): Promise<void> {
    await page.goto(url, { waitUntil: "load", timeout: LOAD_MS });
    try {
        await page.waitForLoadState("networkidle", { timeout: QUIET_MS });
    } catch (error) {
        log.debug({ url, error: reason(error) }, "fresh page never fell quiet; reading it anyway");
    }
}

// `use` on a new page in the crawler’s context, closed after, so the crawler’s own page stays as rendered.
export async function withPage<T>(live: Page, use: (page: Page) => Promise<T>): Promise<T> {
    const page = await live.context().newPage();
    try {
        return await use(page);
    } finally {
        await page.close();
    }
}
