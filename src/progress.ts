// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { logUpdateStderr } from "log-update";
import { relative } from "./crawl/scope.ts";
import { log } from "./logger.ts";

const BAR_WIDTH = 20;
const REDRAW_MS = 1000;
const ETA_WINDOW = 50;
const ETA_MIN_SAMPLES = 3;
const ETA_Z = 2;
const COUNT_MS = 250;

// What a run does, in order: the crawl, then the work on its pages, then the rules.
export const PHASES = ["crawl", "resources", "probes", "site", "lint"] as const;
export type Phase = (typeof PHASES)[number];

// What each phase is called on the status line.
const PHASE_TEXT: Record<Phase, string> = { crawl: "crawling", resources: "linked resources", probes: "external links", site: "site checks", lint: "rules" };

// The status line: whether it draws, what it shows, the origin trimmed from its URL, the phase and how far inside it.
const state = { isOn: false, isShown: false, done: 0, total: 0, page: "", step: "", since: 0, origin: "", last: 0, notified: 0, phase: "crawl" as Phase, count: undefined as { done: number; total: number } | undefined, intervals: [] as number[] };

// A time left as whole numbers in one unit `Intl` names.
export interface EtaSpan {
    low: number;
    high: number;
    unit: "second" | "minute" | "hour";
}

// Done and known pages, the phase the run is in with its own count where it has one, and the ETA, as a listener receives them.
export interface Progress {
    done: number;
    total: number;
    phase: Phase;
    step?: { done: number; total: number };
    eta?: EtaSpan;
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
    state.notified = Date.now();
    observer.listener?.({ done: state.done, total, phase: state.phase, ...(state.count && { step: { ...state.count } }), ...(range && { eta: etaSpan(range) }) });
}

// Turns the status line on for an interactive run; `--no-progress`, a pipe or JSON logs keep it off.
export function enableProgress(isOn: boolean): void {
    state.isOn = isOn;
}

// Whether the status line draws, so per-page logs can step down to debug.
export function isProgressOn(): boolean {
    return state.isOn;
}

// Moves the run into `phase`, which has `total` things to do when it knows; the status line comes back for it, and the listener hears it at once.
export function progressPhase(phase: Phase, total?: number): void {
    log.debug({ phase, total }, "progress phase");
    Object.assign(state, { phase, count: total === undefined ? undefined : { done: 0, total }, page: "", step: "", since: Date.now() });
    if (state.isOn) state.isShown = true;
    progressDraw();
    notify();
}

// Counts `done` things finished inside the phase; the listener hears it at most four times a second, and the last one always.
export function progressCount(done: number): void {
    if (!state.count) return;
    state.count.done = done;
    progressDraw();
    if (done >= state.count.total || Date.now() - state.notified >= COUNT_MS) notify();
}

// Clears the status line once the run no longer reports, whichever phase it ended in.
export function progressEnd(): void {
    if (!state.isShown) return;
    logUpdateStderr.clear();
    logUpdateStderr.done();
    state.isShown = false;
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

// The range as whole numbers in the unit the high end reaches: the low end rounded down, the high end up.
export function etaSpan(range: [number, number]): EtaSpan {
    const [size, unit] = range[1] < 60 ? [1, "second" as const] : range[1] < 3600 ? [60, "minute" as const] : [3600, "hour" as const];
    return { low: Math.floor(range[0] / size), high: Math.ceil(range[1] / size), unit };
}

const SUFFIX: Record<EtaSpan["unit"], string> = { second: "s", minute: "min", hour: "h" };

// The range as `ETA 2–4 min`, `ETA under 3 min` while the low end is zero, one value when both ends meet.
export function etaText(range: [number, number] | undefined): string {
    if (!range) return "";
    const { low, high, unit } = etaSpan(range);
    if (low === high) return `ETA ${high} ${SUFFIX[unit]}`;
    return low === 0 ? `ETA under ${high} ${SUFFIX[unit]}` : `ETA ${low}–${high} ${SUFFIX[unit]}`;
}

// What the run is at: the page in flight while crawling, else the phase with its count.
function where(): string {
    if (state.phase === "crawl") return relative(state.page, state.origin);
    return `${PHASE_TEXT[state.phase]}${state.count ? ` ${state.count.done}/${state.count.total}` : ""}`;
}

// The line as drawn: a bar, done/known, the ETA, the step, the page, seconds on the step.
function line(): string {
    const { done } = state;
    const total = Math.max(done, state.total);
    const filled = total > 0 ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)) : 0;
    const seconds = state.since > 0 ? `${Math.round((Date.now() - state.since) / 1000)} s` : "";
    return [`▕${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}▏`, `${done}/${total}`, etaText(eta(state.intervals, total - done)), state.step, where(), seconds].filter(Boolean).join(" ");
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
    Object.assign(state, { isShown: state.isOn, origin, last: Date.now(), intervals: [], phase: "crawl", count: undefined });
    const timer = setInterval(() => void refresh(known), REDRAW_MS);
    timer.unref();
    return () => {
        clearInterval(timer);
        if (state.isShown) logUpdateStderr.clear();
        if (state.isShown) logUpdateStderr.done();
        state.isShown = false;
    };
}
