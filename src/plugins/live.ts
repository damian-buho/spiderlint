// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { reason } from "../crawl/fetch.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule } from "../rules/builtin.ts";
import { said } from "../rules/message.ts";
import type { Element } from "./keyboard.ts";
import { definePlugin } from "./types.ts";
import { DESCRIBE, visit, withPage } from "./visit.ts";

const ID = "live";
// Click listeners resolved per page, at most.
const MAX_LISTENERS = 200;
// Font size in CSS pixels under which iOS Safari zooms into a focused field.
const MIN_FONT = 16;
// Elements listed per forced-colours fact, at most.
const MAX_FORCED = 50;

export interface LiveFacts {
    // Animations still running once the page fell quiet under `prefers-reduced-motion: reduce`: endless, or longer than 5 s.
    motion: (Element & { name: string; seconds?: number })[];
    videos: Element[];
    // `<div>` and `<span>` taking clicks with no role; absent without CDP.
    clickables?: Element[];
    inputs: (Element & { size: number })[];
    "service-workers": { scope: string; script?: string }[];
    // Present when the page defines `navigator.modelContext`.
    webmcp?: { tools: string[] };
    // Text axe finds too faint in the dark scheme; present only when the page claims dark support.
    dark?: (Element & { contrast?: string })[];
    // Under forced colours: controls left with nothing drawn, and opted-out elements holding text in author colours.
    forced: { icons: Element[]; "opt-out": (Element & { colors: string })[] };
    // Whether a sheet answers `prefers-contrast: more`, and the text axe finds below 7:1 once it does.
    contrast: { claimed: boolean; faint?: (Element & { contrast?: string })[] };
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
    const media = (sheet) => { try { return [sheet.media?.mediaText ?? "", ...[...sheet.cssRules].flatMap(function texts(rule) { return [rule.conditionText ?? "", ...(rule.cssRules ? [...rule.cssRules].flatMap(texts) : [])]; })]; } catch { return [sheet.media?.mediaText ?? ""]; } };
    const conditions = [...document.styleSheets].flatMap(media).map((text) => text.replaceAll(" ", ""));
    const isDark = [document.querySelector('meta[name="color-scheme"]')?.content ?? "", getComputedStyle(document.documentElement).colorScheme].some((value) => value.includes("dark")) || conditions.some((text) => text.includes("prefers-color-scheme:dark"));
    const isContrast = conditions.some((text) => /prefers-contrast(?::more|[)])/.test(text));
    const tools = "modelContext" in navigator ? ((await navigator.modelContextTesting?.listTools?.()) ?? []).map((tool) => tool.name) : undefined;
    return { motion, videos, inputs, "service-workers": serviceWorkers, ...(tools && { webmcp: { tools } }), isDark, isContrast };
})()`;

// Under forced colours: shown controls with no visible text, media or surviving paint, and opt-out roots holding visible text.
const FORCED = `(() => {
    ${DESCRIBE}
    const shown = (node) => node.checkVisibility({ visibilityProperty: true }) && node.getBoundingClientRect().width > 0;
    const hasText = (root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.data.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const box = range.getBoundingClientRect();
            if (box.width > 1 && box.height > 1) return true;
        }
        return false;
    };
    const paints = (node, pseudo) => {
        const style = getComputedStyle(node, pseudo);
        if (pseudo && !["none", "normal", '""'].includes(style.content)) return true;
        return (style.backgroundImage !== "none" || style.maskImage !== "none") && (style.maskImage === "none" || style.forcedColorAdjust === "none");
    };
    const drawn = (control) => hasText(control) || [...control.querySelectorAll("img, svg, picture, canvas, video, object")].some(shown) || [control, ...control.querySelectorAll("*")].slice(0, 20).some((node) => paints(node, null) || paints(node, "::before") || paints(node, "::after"));
    const icons = [...document.querySelectorAll('a[href], button, [role="button"]')].filter((control) => shown(control) && !drawn(control)).slice(0, ${MAX_FORCED}).map((control) => describe(control));
    const optOut = [...document.querySelectorAll("body *")].filter((node) => getComputedStyle(node).forcedColorAdjust === "none" && getComputedStyle(node.parentElement).forcedColorAdjust !== "none" && shown(node) && hasText(node)).slice(0, ${MAX_FORCED}).map((node) => { const style = getComputedStyle(node); return { ...describe(node), colors: style.color + " on " + style.backgroundColor }; });
    return { icons, "opt-out": optOut };
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

// Text axe’s `rule` finds below its contrast ratio in the page as it renders now.
async function faint(page: Page, rule = "color-contrast"): Promise<(Element & { contrast?: string })[]> {
    const results = await new AxeBuilder({ page }).withRules([rule]).analyze();
    return results.violations
        .flatMap((violation) => violation.nodes)
        .map((node) => {
            const data = node.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string } | undefined;
            return { target: node.target.flat().join(" >>> "), html: /^<[^>]*>/.exec(node.html)?.[0] ?? node.html, ...(data?.contrastRatio !== undefined && { contrast: `${data.fgColor} on ${data.bgColor} ${data.contrastRatio}:1, needs ${data.expectedContrastRatio}` }) };
        });
}

// Text axe finds below 7:1 in a fresh copy of the page loaded as a visitor asking for more contrast.
async function enhanced(live: Page, url: string): Promise<(Element & { contrast?: string })[]> {
    return withPage(live, async (fresh) => {
        await fresh.emulateMedia({ contrast: "more" });
        await visit(fresh, url);
        const found = await faint(fresh, "color-contrast-enhanced");
        log.debug({ url, faint: found.length }, "increased contrast read");
        return found;
    });
}

// Reads a fresh copy of the page loaded as a visitor asking for reduced motion and a dark scheme, then forcing colours, leaving the crawler’s own page as rendered.
async function extract(page: Facts, _body: string, live?: Page): Promise<LiveFacts | undefined> {
    if (!live || !page.html) return;
    const read = await withPage(live, async (fresh) => {
        await fresh.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
        await visit(fresh, page.url.href);
        const { isDark, isContrast, ...facts } = (await fresh.evaluate(READ)) as Omit<LiveFacts, "forced" | "contrast"> & { isDark: boolean; isContrast: boolean };
        const dark = isDark ? await faint(fresh) : undefined;
        const found = await clickables(fresh, page.url.href);
        await fresh.emulateMedia({ forcedColors: "active" });
        const forced = (await fresh.evaluate(FORCED)) as LiveFacts["forced"];
        log.debug(
            { url: page.url.href, motion: facts.motion.length, videos: facts.videos.length, inputs: facts.inputs.length, serviceWorkers: facts["service-workers"].length, webmcp: facts.webmcp?.tools.length, isDark, faint: dark?.length, icons: forced.icons.length, optOut: forced["opt-out"].length, isContrast },
            "live page read",
        );
        return { ...facts, ...(found && { clickables: found }), ...(dark && { dark }), forced, isContrast };
    });
    const { isContrast, ...facts } = read;
    return { ...facts, contrast: { claimed: isContrast, ...(isContrast && { faint: await enhanced(live, page.url.href) }) } };
}

const liveOf = (page: Facts) => page[ID] as LiveFacts | undefined;
const located = (element: Element) => `${element.target} ${element.html}`;

const reducedMotion = pageRule(
    "live/reduced-motion",
    [`${ID}.motion`, `${ID}.videos`],
    (page) => {
        const facts = liveOf(page);
        if (!facts) return;
        const moving = [...facts.motion.map((entry) => `${located(entry)} ${entry.name} ${entry.seconds === undefined ? "endless" : `${entry.seconds} s`}`), ...facts.videos.map((video) => `${located(video)} autoplays`)];
        return moving.length === 0 ? [] : [{ ...said("animations and videos keep moving although the visitor asks for reduced motion"), data: { [page.url.href]: { animations: facts.motion.length, videos: facts.videos.length } }, value: moving, locations: moving }];
    },
    { docs: "https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html", fix: "Stop endless and long animations and autoplay inside `@media (prefers-reduced-motion: reduce)`." },
);

const clickListener = pageRule(
    "live/click-listener",
    [`${ID}.clickables`],
    (page) => {
        const found = liveOf(page)?.clickables;
        if (!found) return;
        return found.length === 0 ? [] : [{ ...said("a <div> or <span> takes clicks with no role, so neither keyboards nor screen readers find it"), data: { [page.url.href]: { elements: found.length } }, value: found.map((element) => element.target), locations: found.map((element) => located(element)) }];
    },
    { docs: "https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/", fix: 'Use `<button>` or `<a href>`; a custom control needs a role, `tabindex="0"` and a key handler too.' },
);

const inputFontSize = pageRule(
    "live/input-font-size",
    [`${ID}.inputs`],
    (page) => {
        const small = liveOf(page)?.inputs;
        if (!small) return;
        return small.length === 0
            ? []
            : [{ ...said("a form field is set under {limit} px, so iOS Safari zooms in on focus", { limit: MIN_FONT }), data: { [page.url.href]: { fields: small.length } }, value: small.map((field) => `${field.target} ${field.size} px`), locations: small.map((field) => `${located(field)} ${field.size} px`) }];
    },
    { docs: "https://developer.mozilla.org/docs/Web/HTML/Viewport_meta_tag", fix: "Give inputs, selects and text areas `font-size: 16px` or more; measured at the crawler’s desktop viewport, so a phone-only media query goes unseen." },
);

const darkContrast = pageRule(
    "live/dark-contrast",
    [`${ID}.dark`],
    (page) => {
        const faintText = liveOf(page)?.dark;
        if (!faintText) return;
        return faintText.length === 0
            ? []
            : [
                  {
                      ...said("an element is too faint to read in the dark scheme the page claims to support"),
                      data: { [page.url.href]: { elements: faintText.length } },
                      value: faintText.map((element) => element.target),
                      locations: faintText.map((element) => `${located(element)}${element.contrast ? ` ${element.contrast}` : ""}`),
                  },
              ];
    },
    { docs: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html", fix: "Give every `prefers-color-scheme: dark` colour a matching background, or drop `dark` from `color-scheme` until the dark styles exist." },
);

const forcedIcons = pageRule(
    "live/forced-icons",
    [`${ID}.forced.icons`],
    (page) => {
        const blank = liveOf(page)?.forced?.icons;
        if (!blank) return;
        return blank.length === 0
            ? []
            : [
                  {
                      ...said("a control shows nothing under forced colours: no visible text, and its icon is a gradient or a mask the system colours paint over"),
                      data: { [page.url.href]: { controls: blank.length } },
                      value: blank.map((element) => element.target),
                      locations: blank.map((element) => located(element)),
                  },
              ];
    },
    { docs: "https://developer.mozilla.org/docs/Web/CSS/@media/forced-colors", fix: "Draw icons with inline SVG in `currentColor` or an `<img>`; a masked icon needs `forced-color-adjust: none` and `background-color: ButtonText` under `@media (forced-colors: active)`." },
);

const forcedOptOut = pageRule(
    "live/forced-opt-out",
    [`${ID}.forced.opt-out`],
    (page) => {
        const kept = liveOf(page)?.forced?.["opt-out"];
        if (!kept) return;
        return kept.length === 0 ? [] : [{ ...said("an element keeps its own text colours under forced colours"), data: { [page.url.href]: { elements: kept.length } }, value: kept.map((element) => element.target), locations: kept.map((element) => `${located(element)} ${element.colors}`) }];
    },
    { docs: "https://developer.mozilla.org/docs/Web/CSS/forced-color-adjust", fix: "Keep `forced-color-adjust: none` to small graphics such as logos and swatches, never on text." },
);

const contrastMore = pageRule(
    "live/contrast-more",
    [`${ID}.contrast.claimed`],
    (page) => {
        const contrast = liveOf(page)?.contrast;
        if (!contrast) return;
        return contrast.claimed ? [] : [{ ...said("no style answers `prefers-contrast: more`, so a visitor asking for more contrast sees the default colours"), value: false }];
    },
    { docs: "https://developer.mozilla.org/docs/Web/CSS/@media/prefers-contrast", fix: "Darken muted text and borders inside `@media (prefers-contrast: more)`, aiming at 7:1." },
);

const contrastEnhanced = pageRule(
    "live/contrast-enhanced",
    [`${ID}.contrast.faint`],
    (page) => {
        const faintText = liveOf(page)?.contrast?.faint;
        if (!faintText) return;
        return faintText.length === 0
            ? []
            : [
                  {
                      ...said("an element stays below 7:1 when the visitor asks for the more contrast the page answers"),
                      data: { [page.url.href]: { elements: faintText.length } },
                      value: faintText.map((element) => element.target),
                      locations: faintText.map((element) => `${located(element)}${element.contrast ? ` ${element.contrast}` : ""}`),
                  },
              ];
    },
    { docs: "https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html", fix: "Raise every colour pair inside `@media (prefers-contrast: more)` to 7:1, or 4.5:1 for large text." },
);

const webmcp = pageRule(
    "live/webmcp",
    [`${ID}.webmcp`],
    (page) => {
        const tools = liveOf(page)?.webmcp?.tools;
        if (!tools) return;
        return tools.length === 0 ? [{ ...said("the browser supports WebMCP but the page registers no tools, so an agent in it can only click and read"), data: { [page.url.href]: { tools: 0 } }, value: tools }] : [];
    },
    { docs: "https://webmcp.org/", fix: "Register the page’s actions as WebMCP tools with `navigator.modelContext`, so an in-browser agent calls them instead of driving the interface." },
);

export default definePlugin({
    name: "live",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", inputs: ["resources"], extract }],
    rules: {
        "live/reduced-motion": reducedMotion,
        "live/click-listener": clickListener,
        "live/input-font-size": inputFontSize,
        "live/dark-contrast": darkContrast,
        "live/forced-icons": forcedIcons,
        "live/forced-opt-out": forcedOptOut,
        "live/contrast-more": contrastMore,
        "live/contrast-enhanced": contrastEnhanced,
        "live/webmcp": webmcp,
    },
    presets: {
        live: {
            description: "The rendered page on sampled pages: motion under reduced-motion, contrast in a claimed dark scheme and under increased contrast, icons and opt-outs under forced colours, click handlers on plain elements, form fields small enough to zoom",
            rules: {
                "live/reduced-motion": { severity: "warning", score: 6.2 },
                "live/dark-contrast": { severity: "warning", score: 5.6 },
                "live/contrast-enhanced": { severity: "warning", score: 5 },
                "live/forced-icons": { severity: "warning", score: 5.4 },
                "live/click-listener": { severity: "warning", score: 5.2 },
                "live/input-font-size": { severity: "info", score: 2.6 },
                "live/contrast-more": { severity: "info", score: 1.6 },
                "live/forced-opt-out": { severity: "info", score: 2.4 },
                "live/webmcp": { severity: "info", score: 0.8 },
            },
        },
    },
});
