// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { logUpdateStderr } from "log-update";
import { relative } from "./crawl/scope.ts";
import { log } from "./logger.ts";

const BAR_WIDTH = 20;
const REDRAW_MS = 1000;

// The status line: whether it draws, what it shows, the origin trimmed from its URL.
const state = { isOn: false, isShown: false, done: 0, total: 0, page: "", step: "", since: 0, origin: "" };

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
    Object.assign(state, { done, page: "", step: "", since: 0 });
    progressDraw();
}

// The line as drawn: a bar, done/known, the step, the page, seconds on the step.
function line(): string {
    const { done } = state;
    const total = Math.max(done, state.total);
    const filled = total > 0 ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)) : 0;
    const seconds = state.since > 0 ? `${Math.round((Date.now() - state.since) / 1000)} s` : "";
    return [`▕${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}▏`, `${done}/${total}`, state.step, relative(state.page, state.origin), seconds].filter(Boolean).join(" ");
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
}

// Redraws each second from `known` until the returned stop runs, which clears the line.
export function trackProgress(known: () => Promise<number>, origin: string): () => void {
    if (!state.isOn) return () => {};
    Object.assign(state, { isShown: true, origin });
    const timer = setInterval(() => void refresh(known), REDRAW_MS);
    timer.unref();
    return () => {
        clearInterval(timer);
        logUpdateStderr.clear();
        logUpdateStderr.done();
        state.isShown = false;
    };
}
