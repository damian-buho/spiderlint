// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import { reason } from "../crawl/fetch.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule } from "../rules/builtin.ts";
import type { Element } from "./keyboard.ts";
import { definePlugin } from "./types.ts";
import { DESCRIBE, visit, withPage } from "./visit.ts";

const ID = "live";
// Click listeners resolved per page, at most.
const MAX_LISTENERS = 200;
// Font size in CSS pixels under which iOS Safari zooms into a focused field.
const MIN_FONT = 16;

export interface LiveFacts {
    // Animations still running once the page fell quiet under `prefers-reduced-motion: reduce`: endless, or longer than 5 s.
    motion: (Element & { name: string; seconds?: number })[];
    videos: Element[];
    // `<div>` and `<span>` taking clicks with no role; absent without CDP.
    clickables?: Element[];
    inputs: (Element & { size: number })[];
    serviceWorkers: { scope: string; script?: string }[];
    // Present when the page defines `navigator.modelContext`.
    webmcp?: { tools: string[] };
}

// What the page does under reduced motion, form fields below MIN_FONT, and the workers and WebMCP tools it registered.
const READ = `(async () => {
    ${DESCRIBE}
    const motion = document.getAnimations().filter((animation) => animation.playState === "running").flatMap((animation) => {
        const end = animation.effect?.getComputedTiming().endTime ?? 0;
        if (end !== Infinity && end <= 5000) return [];
        const target = animation.effect?.target;
        return [{ ...(target ? describe(target) : { target: "document", html: "" }), name: animation.animationName ?? animation.transitionProperty ?? (animation.id || "script"), ...(end !== Infinity && { seconds: Math.round(end / 1000) }) }];
    });
    const videos = [...document.querySelectorAll("video")].filter((video) => video.autoplay && !video.paused).map((video) => describe(video));
    const SKIPPED = ["hidden", "checkbox", "radio", "submit", "button", "reset", "image", "file", "range", "color"];
    const inputs = [...document.querySelectorAll("input, select, textarea")].filter((field) => !SKIPPED.includes(field.type) && field.checkVisibility()).flatMap((field) => {
        const size = Number.parseFloat(getComputedStyle(field).fontSize);
        return size < ${MIN_FONT} ? [{ ...describe(field), size }] : [];
    });
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    const serviceWorkers = registrations.map((registration) => ({ scope: registration.scope, ...((registration.active ?? registration.waiting ?? registration.installing) && { script: (registration.active ?? registration.waiting ?? registration.installing).scriptURL }) }));
    const tools = "modelContext" in navigator ? ((await navigator.modelContextTesting?.listTools?.()) ?? []).map((tool) => tool.name) : undefined;
    return { motion, videos, inputs, serviceWorkers, ...(tools && { webmcp: { tools } }) };
})()`;

// Describes an element CDP found taking clicks, when it is a `<div>` or `<span>` with no role outside a native control.
const CLICKABLE = `function () {
    ${DESCRIBE}
    return ["div", "span"].includes(this.localName) && !this.hasAttribute("role") && !this.closest("a[href], button, label, summary") ? describe(this) : null;
}`;

// Elements with their own click listener, through Chromium’s DevTools protocol; undefined in a browser without it.
async function clickables(page: Page, url: string): Promise<Element[] | undefined> {
    let cdp;
    try {
        cdp = await page.context().newCDPSession(page);
    } catch (error) {
        log.debug({ url, error: reason(error) }, "no DevTools protocol; click listeners unread");
        return;
    }
    try {
        const { result } = await cdp.send("Runtime.evaluate", { expression: "document.documentElement" });
        const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId as string, depth: -1, pierce: true });
        const nodes = [...new Set(listeners.filter((listener) => listener.type === "click" && listener.backendNodeId !== undefined).map((listener) => listener.backendNodeId as number))];
        const found: Element[] = [];
        for (const backendNodeId of nodes.slice(0, MAX_LISTENERS)) {
            const { object } = await cdp.send("DOM.resolveNode", { backendNodeId });
            const { result: described } = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId as string, functionDeclaration: CLICKABLE, returnByValue: true });
            if (described.value) found.push(described.value as Element);
        }
        log.debug({ url, listeners: nodes.length, read: Math.min(nodes.length, MAX_LISTENERS), found: found.length }, "click listeners read");
        return found;
    } finally {
        await cdp.detach();
    }
}

// Reads a fresh copy of the page loaded under `prefers-reduced-motion: reduce`, leaving the crawler’s own page as rendered.
async function extract(page: Facts, _body: string, live?: Page): Promise<LiveFacts | undefined> {
    if (!live || !page.html) return;
    return withPage(live, async (fresh) => {
        await fresh.emulateMedia({ reducedMotion: "reduce" });
        await visit(fresh, page.url.href);
        const facts = (await fresh.evaluate(READ)) as LiveFacts;
        const found = await clickables(fresh, page.url.href);
        log.debug({ url: page.url.href, motion: facts.motion.length, videos: facts.videos.length, inputs: facts.inputs.length, serviceWorkers: facts.serviceWorkers.length, webmcp: facts.webmcp?.tools.length }, "live page read");
        return { ...facts, ...(found && { clickables: found }) };
    });
}

const liveOf = (page: Facts) => page[ID] as LiveFacts | undefined;
const located = (element: Element) => `${element.target} ${element.html}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const reducedMotion = pageRule("live/reduced-motion", [`${ID}.motion`, `${ID}.videos`], (page) => {
    const facts = liveOf(page);
    if (!facts) return;
    const moving = [...facts.motion.map((entry) => `${located(entry)} ${entry.name} ${entry.seconds === undefined ? "endless" : `${entry.seconds} s`}`), ...facts.videos.map((video) => `${located(video)} autoplays`)];
    return moving.length === 0 ? [] : [{ message: `${plural(facts.motion.length, "animation", "animations")} and ${plural(facts.videos.length, "video", "videos")} keep moving although the visitor asks for reduced motion`, value: moving, locations: moving }];
}, { docs: "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html", fix: "Stop endless and long animations and autoplay inside `@media (prefers-reduced-motion: reduce)`." });

const clickListener = pageRule("live/click-listener", [`${ID}.clickables`], (page) => {
    const found = liveOf(page)?.clickables;
    if (!found) return;
    return found.length === 0 ? [] : [{ message: `${plural(found.length, "<div> or <span> takes", "<div> or <span> elements take")} clicks with no role, so neither keyboards nor screen readers find ${found.length === 1 ? "it" : "them"}`, value: found.map((element) => element.target), locations: found.map((element) => located(element)) }];
}, { docs: "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/", fix: "Use `<button>` or `<a href>`; a custom control needs a role, `tabindex=\"0\"` and a key handler too." });

const inputFontSize = pageRule("live/input-font-size", [`${ID}.inputs`], (page) => {
    const small = liveOf(page)?.inputs;
    if (!small) return;
    return small.length === 0 ? [] : [{ message: `${plural(small.length, "form field is", "form fields are")} set under ${MIN_FONT} px, so iOS Safari zooms in on focus`, value: small.map((field) => `${field.target} ${field.size} px`), locations: small.map((field) => `${located(field)} ${field.size} px`) }];
}, { docs: "https://developer.mozilla.org/docs/Web/HTML/Viewport_meta_tag", fix: "Give inputs, selects and text areas `font-size: 16px` or more; measured at the crawler’s desktop viewport, so a phone-only media query goes unseen." });

export default definePlugin({
    name: "live",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", cached: false, extract }],
    rules: { "live/reduced-motion": reducedMotion, "live/click-listener": clickListener, "live/input-font-size": inputFontSize },
    presets: {
        live: {
            description: "The rendered page on sampled pages: motion under reduced-motion, click handlers on plain elements, form fields small enough to zoom",
            rules: { "live/reduced-motion": "warning", "live/click-listener": "warning", "live/input-font-size": "info" },
        },
    },
});
