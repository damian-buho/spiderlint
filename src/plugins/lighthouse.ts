// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import { debuggingPort } from "../crawl/browser.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "lighthouse";
// The lab metrics kept, by the Lighthouse audit that measures each.
const VITALS = { lcp: "largest-contentful-paint", cls: "cumulative-layout-shift", tbt: "total-blocking-time", fcp: "first-contentful-paint", si: "speed-index", ttfb: "server-response-time" } as const;

export interface LighthouseFacts {
    version: string;
    "form-factor": string;
    // Category scores from 0 to 1, by category ID.
    scores: Record<string, number>;
    // Milliseconds, CLS unitless.
    vitals: Partial<Record<keyof typeof VITALS, number>>;
}

// The offending value’s placeholder in a rule message.
const GOT = "{got}";
// The Lighthouse run in flight: its marks are process-global and Chromium traces once, so runs queue.
const lane = { tail: Promise.resolve() };

// Runs `audit` once every earlier call has settled.
async function queued<T>(audit: () => Promise<T>): Promise<T> {
    const previous = lane.tail;
    const { promise, resolve } = Promise.withResolvers<void>();
    lane.tail = promise;
    await previous;
    try {
        return await audit();
    } finally {
        resolve();
    }
}

// Runs Lighthouse in a new tab of the crawler’s Chromium, reached through its DevTools port; Lighthouse loads on first use.
async function extract(page: Facts, _body: string, live?: Page): Promise<LighthouseFacts | undefined> {
    if (!live || !page.html) return;
    const port = debuggingPort(live);
    if (port === undefined) {
        log.debug({ url: page.url.href }, "no DevTools port; no Lighthouse facts");
        return;
    }
    const { default: lighthouse } = await import("lighthouse");
    log.debug({ url: page.url.href, port }, "Lighthouse queued");
    const result = await queued(() => lighthouse(page.url.href, { port, output: "json", logLevel: "error" }));
    const lhr = result?.lhr;
    if (!lhr) return;
    if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    const scores = Object.fromEntries(Object.entries(lhr.categories).flatMap(([id, category]) => (category.score === null ? [] : [[id, category.score]])));
    const vitals = Object.fromEntries(
        Object.entries(VITALS).flatMap(([key, audit]) => {
            const value = lhr.audits[audit]?.numericValue;
            return value === undefined ? [] : [[key, key === "cls" ? Number(value.toFixed(3)) : Math.round(value)]];
        }),
    );
    log.debug({ url: page.url.href, port, scores, vitals, warnings: lhr.runWarnings }, "Lighthouse audited");
    return { version: lhr.lighthouseVersion, "form-factor": lhr.configSettings.formFactor, scores, vitals };
}

// A category score of at least 0.9, Lighthouse’s own green.
function score(category: string, label: string, link: string): RuleSpec {
    return { fact: `${ID}.scores.${category}`, expect: { type: "number", minimum: 0.9 }, severity: "warning", message: `Lighthouse ${label} score is ${GOT}, under 0.9`, docs: link, fix: `Fix the failing audits Lighthouse lists under ${label}, largest savings first.` };
}

// A lab metric at most `limit`, the bound Lighthouse marks good.
function metric(key: keyof typeof VITALS, limit: number, unit: string, link: string): RuleSpec {
    return { fact: `${ID}.vitals.${key}`, expect: { type: "number", maximum: limit }, severity: "warning", message: `${key.toUpperCase()} is ${GOT}${unit} in the lab, over ${limit}${unit}`, docs: link, fix: `Reduce ${key.toUpperCase()} below ${limit}${unit}; the Lighthouse report names the elements and resources behind it.` };
}

export default definePlugin({
    name: "lighthouse",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", cached: false, debugging: true, extract }],
    presets: {
        lighthouse: {
            description: "Lighthouse on sampled pages: performance, accessibility, best-practices and SEO scores, and lab LCP, CLS, TBT and FCP",
            rules: {
                "lighthouse/performance": score("performance", "performance", "https://developer.chrome.com/docs/lighthouse/performance/performance-scoring"),
                "lighthouse/accessibility": score("accessibility", "accessibility", "https://developer.chrome.com/docs/lighthouse/accessibility/scoring"),
                "lighthouse/best-practices": score("best-practices", "best-practices", "https://developer.chrome.com/docs/lighthouse/overview"),
                "lighthouse/seo": score("seo", "SEO", "https://developer.chrome.com/docs/lighthouse/overview"),
                "lighthouse/lcp": metric("lcp", 2500, " ms", "https://web.dev/articles/lcp"),
                "lighthouse/cls": metric("cls", 0.1, "", "https://web.dev/articles/cls"),
                "lighthouse/tbt": metric("tbt", 200, " ms", "https://web.dev/articles/tbt"),
                "lighthouse/fcp": metric("fcp", 1800, " ms", "https://web.dev/articles/fcp"),
            },
        },
    },
});
