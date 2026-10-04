// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule } from "../rules/builtin.ts";
import { definePlugin } from "./types.ts";
import { DESCRIBE, visit, withPage } from "./visit.ts";

const ID = "keyboard";
// Tab presses allowed per candidate, beyond the count, and in all.
const PER_CANDIDATE = 2;
const SLACK = 10;
const MAX_PRESSES = 300;
// Presses focus may rest on one element, as inside a frame or a media player, before it counts as stuck.
const STUCK = 20;

export interface Element {
    target: string;
    html: string;
}

export interface Stop extends Element {
    // Whether the element, its pseudo-elements, parent or children look different focused.
    visible: boolean;
    // The fixed or sticky element on top of the focused one’s centre.
    "obscured-by"?: string;
    // Whether focus still shows under forced colours; read only where `visible`.
    forced?: boolean;
}

export interface KeyboardFacts {
    stops: Stop[];
    // The walk came back to its first stop or left the page, so `unreached` is final.
    complete: boolean;
    unreached: Element[];
    // Where focus stopped moving, or the stop it cycled back to.
    trap?: string;
    first?: { target: string; "in-main": boolean; "skips-to"?: { target: string; main: boolean } };
}

interface Seen extends Stop {
    index: number;
    inMain: boolean;
    skipsTo?: { target: string; main: boolean };
}

const CANDIDATES = `globalThis[Symbol.for("spiderlint.keyboard")]`;

// A page script defining `look(element)`: the focus-relevant styles of the element, its pseudo-elements, parent and first ten children, outline only when drawn.
const LOOK = `const PROPERTIES = ["outline-style", "outline-width", "outline-color", "box-shadow", "border-color", "border-width", "background-color", "color", "text-decoration-line"];
    const read = (node, pseudo) => { const style = getComputedStyle(node, pseudo); return PROPERTIES.filter((name) => style.outlineStyle !== "none" || !name.startsWith("outline-")).map((name) => style.getPropertyValue(name)).join("|"); };
    const look = (element) => [read(element, null), read(element, "::before"), read(element, "::after"), ...(element.parentElement ? [read(element.parentElement, null)] : []), ...[...element.children].slice(0, 10).map((child) => read(child, null))].join(" / ");`;

// Lists what a keyboard user must reach and stills transitions, so a focus style reads settled; answers the count.
const MARK = `(() => {
    const selector = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], audio[controls], video[controls], [tabindex]';
    const candidates = [...document.querySelectorAll(selector)].filter((element) => !(Number(element.getAttribute("tabindex")) < 0) && !element.matches(":disabled") && !element.closest("[inert]") && element.checkVisibility({ visibilityProperty: true }));
    ${CANDIDATES} = candidates;
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { transition: none !important; }";
    document.head.append(style);
    return candidates.length;
})()`;

// The focused element: where it sits in the candidates, whether focus shows, what covers it, and where a same-page link leads.
const INSPECT = `(() => {
    ${DESCRIBE}
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    if (!element || element === document.body || element === document.documentElement) return null;
    const isAbove = (ancestor, node) => { for (let at = node; at; at = at.parentNode ?? at.host) if (at === ancestor) return true; return false; };
    ${LOOK}
    const focused = look(element);
    let obscuredBy;
    const box = element.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
    const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
    if (hit && !isAbove(element, hit) && !isAbove(hit, element)) {
        for (let node = hit; node; node = node.parentElement) if (["fixed", "sticky"].includes(getComputedStyle(node).position)) { obscuredBy = describe(node).target; break; }
    }
    element.blur?.();
    const visible = look(element) !== focused;
    element.focus?.({ preventScroll: true });
    const main = document.querySelector("main, [role=main]");
    let skipsTo;
    if (element instanceof HTMLAnchorElement && element.hash && element.href.split("#")[0] === location.href.split("#")[0]) {
        const id = decodeURIComponent(element.hash.slice(1));
        const target = document.getElementById(id) ?? document.getElementsByName(id)[0];
        if (target) skipsTo = { target: describe(target).target, main: Boolean(main && (target === main || target.contains(main) || main.contains(target))) };
    }
    return { index: (${CANDIDATES} ?? []).indexOf(element), ...describe(element), visible, ...(obscuredBy && { "obscured-by": obscuredBy }), inMain: Boolean(main?.contains(element)), ...(skipsTo && { skipsTo }) };
})()`;

// Candidates Tab never reached and still shown; a radio group counts as reached through any of its radios.
function missed(reached: number[]): string {
    return `(() => {
        ${DESCRIBE}
        const candidates = ${CANDIDATES} ?? [];
        const reached = new Set(${JSON.stringify(reached)});
        const groups = new Set([...reached].map((index) => candidates[index]).filter((element) => element?.type === "radio").map((element) => element.name));
        return candidates.filter((element, index) => !reached.has(index) && element.isConnected && element.checkVisibility({ visibilityProperty: true }) && !(element.type === "radio" && groups.has(element.name))).map((element) => describe(element));
    })()`;
}

// Candidate indexes whose focus shows no change once refocused from script, as `INSPECT` compares.
function unchanged(indexes: number[]): string {
    return `(() => {
        ${LOOK}
        const candidates = ${CANDIDATES} ?? [];
        return ${JSON.stringify(indexes)}.filter((index) => {
            const element = candidates[index];
            if (!element?.isConnected) return false;
            element.focus({ preventScroll: true });
            const focused = look(element);
            element.blur();
            return look(element) === focused;
        });
    })()`;
}

// Presses Tab until focus wraps to its first stop, leaves the page, stops moving, or cycles back to a later stop.
async function walk(page: Page, url: string): Promise<KeyboardFacts> {
    const count = (await page.evaluate(MARK)) as number;
    const limit = Math.min(count * PER_CANDIDATE + SLACK, MAX_PRESSES);
    const stops: Seen[] = [];
    const seen = new Map<string, number>();
    let [complete, still, trap] = [false, 0, undefined as string | undefined];
    for (let press = 0; press < limit; press += 1) {
        await page.keyboard.press("Tab");
        const stop = (await page.evaluate(INSPECT)) as Seen | null;
        if (!stop) {
            complete = stops.length > 0;
            if (complete) break;
            continue;
        }
        const at = seen.get(stop.index >= 0 ? `#${stop.index}` : stop.target);
        if (at !== undefined && at === stops.length - 1) {
            still += 1;
            if (still < STUCK) continue;
            trap = stop.target;
            break;
        }
        still = 0;
        if (at === 0) {
            complete = true;
            break;
        }
        if (at !== undefined) {
            trap = stop.target;
            break;
        }
        seen.set(stop.index >= 0 ? `#${stop.index}` : stop.target, stops.length);
        stops.push(stop);
    }
    const unreached = complete ? ((await page.evaluate(missed(stops.map((stop) => stop.index).filter((index) => index >= 0)))) as Element[]) : [];
    const shown = stops.filter((stop) => stop.visible && stop.index >= 0).map((stop) => stop.index);
    await page.emulateMedia({ forcedColors: "active" });
    const lost = new Set((await page.evaluate(unchanged(shown))) as number[]);
    log.debug({ url, candidates: count, limit, stops: stops.length, complete, trap, unreached: unreached.length, forcedRead: shown.length, forcedLost: lost.size }, "keyboard walked");
    const [head] = stops;
    return {
        stops: stops.map(({ target, html, visible, "obscured-by": obscuredBy, index }) => ({ target, html, visible, ...(obscuredBy && { "obscured-by": obscuredBy }), ...(visible && index >= 0 && { forced: !lost.has(index) }) })),
        complete,
        unreached,
        ...(trap && { trap }),
        ...(head && { first: { target: head.target, "in-main": head.inMain, ...(head.skipsTo && { "skips-to": head.skipsTo }) } }),
    };
}

// Walks a fresh copy of the rendered page with Tab, leaving the crawler’s own page to the read-only extractors.
async function extract(page: Facts, _body: string, live?: Page): Promise<KeyboardFacts | undefined> {
    if (!live || !page.html) return;
    return withPage(live, async (fresh) => {
        await visit(fresh, page.url.href);
        return walk(fresh, page.url.href);
    });
}

const keyboardOf = (page: Facts) => page[ID] as KeyboardFacts | undefined;
const located = (element: Element) => `${element.target} ${element.html}`;

const tabWalk = pageRule("keyboard/tab-walk", [`${ID}.trap`, `${ID}.unreached`], (page) => {
    const facts = keyboardOf(page);
    if (!facts) return;
    return [
        ...(facts.trap ? [{ message: `keyboard focus is trapped at ${facts.trap}: Tab stops moving or cycles back`, value: facts.trap, locations: [facts.trap] }] : []),
        ...(facts.unreached.length > 0 ? [{ message: `${facts.unreached.length} interactive element${facts.unreached.length === 1 ? " is" : "s are"} never reached by Tab`, value: facts.unreached, locations: facts.unreached.map((element) => located(element)) }] : []),
    ];
}, { docs: "https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html", fix: "Let Tab reach every control: drop negative tabindex from interactive elements, and release focus from any widget that holds it." });

const focusVisible = pageRule("keyboard/focus-visible", [`${ID}.stops`], (page) => {
    const hidden = keyboardOf(page)?.stops.filter((stop) => !stop.visible);
    if (!hidden) return;
    return hidden.length === 0 ? [] : [{ message: `${hidden.length} element${hidden.length === 1 ? " shows" : "s show"} no visible change when focused`, value: hidden.map((stop) => stop.target), locations: hidden.map((stop) => located(stop)) }];
}, { docs: "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html", fix: "Give `:focus-visible` an outline or box-shadow; never remove the outline without a replacement." });

const focusObscured = pageRule("keyboard/focus-obscured", [`${ID}.stops`], (page) => {
    const covered = keyboardOf(page)?.stops.filter((stop) => stop["obscured-by"]);
    if (!covered) return;
    return covered.length === 0 ? [] : [{ message: `${covered.length} focused element${covered.length === 1 ? " is" : "s are"} hidden under fixed or sticky content`, value: covered.map((stop) => stop.target), locations: covered.map((stop) => `${located(stop)} under ${stop["obscured-by"]}`) }];
}, { docs: "https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html", fix: "Set `scroll-padding-top` to the sticky header’s height, or keep banners from covering the content." });

const forcedFocus = pageRule("keyboard/forced-focus", [`${ID}.stops`], (page) => {
    const lost = keyboardOf(page)?.stops.filter((stop) => stop.forced === false);
    if (!lost) return;
    return lost.length === 0 ? [] : [{ message: `${lost.length} element${lost.length === 1 ? " loses its" : "s lose their"} focus indicator under forced colours`, value: lost.map((stop) => stop.target), locations: lost.map((stop) => located(stop)) }];
}, { docs: "https://developer.mozilla.org/docs/Web/CSS/@media/forced-colors", fix: "Add `outline: 2px solid transparent` beside a `box-shadow` focus ring; forced colours drop the shadow and paint the outline." });

const skipLink = pageRule("keyboard/skip-link", [`${ID}.first`], (page) => {
    const first = keyboardOf(page)?.first;
    if (!first) return;
    return first["in-main"] || first["skips-to"]?.main ? [] : [{ message: `the first Tab stop is not a link to the main content`, value: first, locations: [first.target] }];
}, { docs: "https://www.w3.org/WAI/WCAG22/Techniques/general/G1", fix: "Make the first focusable element `<a href=\"#main\">Skip to content</a>`, pointing at `<main id=\"main\">`." });

export default definePlugin({
    name: "keyboard",
    extractors: [{ id: ID, mode: "browser", cost: "expensive", inputs: ["resources"], extract }],
    rules: { "keyboard/tab-walk": tabWalk, "keyboard/focus-visible": focusVisible, "keyboard/focus-obscured": focusObscured, "keyboard/forced-focus": forcedFocus, "keyboard/skip-link": skipLink },
    presets: {
        keyboard: {
            description: "Keyboard use on sampled pages: Tab reaches every control without a trap, focus shows, also under forced colours, and is not covered, a skip link comes first",
            rules: { "keyboard/tab-walk": { severity: "warning", score: 6.4 }, "keyboard/focus-visible": { severity: "warning", score: 6 }, "keyboard/focus-obscured": { severity: "warning", score: 5.8 }, "keyboard/forced-focus": { severity: "warning", score: 5.4 }, "keyboard/skip-link": { severity: "info", score: 2.8 } },
        },
    },
});
