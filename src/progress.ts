// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { logUpdateStderr } from "log-update";
import { relative } from "./crawl/scope.ts";
import { log } from "./logger.ts";

const BAR_WIDTH = 20;
const REDRAW_MS = 1000;
const ETA_WINDOW = 50;
const ETA_MIN_SAMPLES = 3;
const ETA_Z = 2;

// The status line: whether it draws, what it shows, the origin trimmed from its URL.
const state = { isOn: false, isShown: false, done: 0, total: 0, page: "", step: "", since: 0, origin: "", last: 0, intervals: [] as number[] };

// Done and known pages with the ETA range in seconds, as a listener receives them.
export interface Progress {
    done: number;
    total: number;
    eta?: [number, number];
}

// Called on every change of done or known pages; the server’s scan runner sets it.
const observer: { listener?: (progress: Progress) => void } = {};

// Hands every progress change to `listener`, status line or not.
export function onProgress(listener: (progress: Progress) => void): void {
    observer.listener = listener;
}

// The current counts to the listener, if one is set.
function notify(): void {
    const total = Math.max(state.done, state.total);
    const range = eta(state.intervals, total - state.done);
    observer.listener?.({ done: state.done, total, ...(range && { eta: range }) });
}

// Turns the status line on for an interactive run; `--no-progress`, a pipe or JSON logs keep it off.
export function enableProgress(isOn: boolean): void {
    state.isOn = isOn;
}

// Whether the status line draws, so per-page logs can step down to debug.
export function isProgressOn(): boolean {
    return state.isOn;
}

// Names the page and step in flight, timed from now.
export function progressStep(page: string, step: string): void {
    Object.assign(state, { page, step, since: Date.now() });
}

// Counts `done` pages finished and clears the step, redrawing at once.
export function progressDone(done: number): void {
    const now = Date.now();
    // One page since the last joins the window; a jump (a resumed store) only moves the baseline.
    const isSampled = state.isShown || observer.listener !== undefined;
    if (isSampled && done - state.done === 1) state.intervals = [...state.intervals, (now - state.last) / 1000].slice(-ETA_WINDOW);
    else if (isSampled) log.debug({ done, previous: state.done, samples: state.intervals.length }, "progress gap not sampled");
    Object.assign(state, { done, page: "", step: "", since: 0, last: now });
    progressDraw();
    notify();
}

// Seconds left as [low, high]: `remaining` gaps at the window’s mean, ± ETA_Z σ of their sum and of the mean itself.
export function eta(intervals: readonly number[], remaining: number): [number, number] | undefined {
    const count = intervals.length;
    if (count < ETA_MIN_SAMPLES || remaining <= 0) return undefined;
    const mean = intervals.reduce((sum, gap) => sum + gap, 0) / count;
    const variance = intervals.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / (count - 1);
    const spread = ETA_Z * Math.sqrt(variance * (remaining + (remaining * remaining) / count));
    return [Math.max(0, remaining * mean - spread), remaining * mean + spread];
}

// A span in its largest whole unit: `[value, unit]`.
function span(seconds: number, round: (value: number) => number): [number, string] {
    const [size, unit] = seconds < 60 ? [1, "s"] : seconds < 3600 ? [60, "min"] : [3600, "h"];
    return [round(seconds / size), unit];
}

// The range as `ETA 2–4 min`, one unit when both ends share it, one value when they meet.
export function etaText(range: [number, number] | undefined): string {
    if (!range) return "";
    const [[low, lowUnit], [high, highUnit]] = [span(range[0], Math.floor), span(range[1], Math.ceil)];
    if (lowUnit !== highUnit) return `ETA ${low} ${lowUnit}–${high} ${highUnit}`;
    return low === high ? `ETA ${high} ${highUnit}` : `ETA ${low}–${high} ${highUnit}`;
}

// The line as drawn: a bar, done/known, the ETA, the step, the page, seconds on the step.
function line(): string {
    const { done } = state;
    const total = Math.max(done, state.total);
    const filled = total > 0 ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)) : 0;
    const seconds = state.since > 0 ? `${Math.round((Date.now() - state.since) / 1000)} s` : "";
    return [`▕${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}▏`, `${done}/${total}`, etaText(eta(state.intervals, total - done)), state.step, relative(state.page, state.origin), seconds].filter(Boolean).join(" ");
}

// Draws the line again in place.
function progressDraw(): void {
    if (state.isShown) logUpdateStderr(line());
}

// Writes `text` above the line, or straight to stderr while it is hidden.
export function progressPrint(text: string): void {
    if (!state.isShown) {
        process.stderr.write(text);
        return;
    }
    logUpdateStderr.persist(text);
    progressDraw();
}

// Reads the known total, keeping the last one when the queue cannot answer, and redraws.
async function refresh(known: () => Promise<number>): Promise<void> {
    try {
        state.total = await known();
    } catch (error) {
        log.debug({ error: String(error), total: state.total }, "progress total unreadable; last kept");
    }
    progressDraw();
    notify();
}

// Redraws each second from `known` until the returned stop runs, which clears the line.
export function trackProgress(known: () => Promise<number>, origin: string): () => void {
    if (!state.isOn && !observer.listener) return () => {};
    Object.assign(state, { isShown: state.isOn, origin, last: Date.now(), intervals: [] });
    const timer = setInterval(() => void refresh(known), REDRAW_MS);
    timer.unref();
    return () => {
        clearInterval(timer);
        if (state.isShown) logUpdateStderr.clear();
        if (state.isShown) logUpdateStderr.done();
        state.isShown = false;
    };
}
