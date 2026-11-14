// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from "./logger.ts";

const ETA_WINDOW = 50;
const ETA_MIN_SAMPLES = 3;
const ETA_Z = 2;
const COUNT_MS = 250;

// What a run does, in order: the crawl, then the work on its pages, then the rules.
export const PHASES = ["crawl", "resources", "probes", "site", "lint"] as const;
export type Phase = (typeof PHASES)[number];

// A time left as whole numbers in one unit `Intl` names.
export interface EtaSpan {
    low: number;
    high: number;
    unit: "second" | "minute" | "hour";
}

// One phase: where it stands, its own count when it has one, and when it started and ended, in epoch ms.
export interface PhaseState {
    status: "pending" | "running" | "done" | "skipped" | "cut";
    done?: number;
    total?: number;
    started?: number;
    ended?: number;
}

// How the run ended, or that it is still going.
export type Outcome = { status: "running" } | { status: "finished" } | { status: "incomplete"; reason: string } | { status: "failed"; error: string };

// Everything a front end reads about a run, as plain JSON.
export interface RunState {
    phase: Phase;
    phases: Record<Phase, PhaseState>;
    pages: { done: number; known: number; eta?: EtaSpan; samples: number[]; last: number; origin: string };
    activity: { page: string; extractor: string; since: number };
    outcome: Outcome;
}

// The only ways a run changes its state, each stamped `at` in epoch ms.
export type RunEvent =
    | { type: "phase.started"; at: number; phase: Phase; total?: number; origin?: string }
    | { type: "phase.counted"; at: number; phase: Phase; done: number }
    | { type: "phase.ended"; at: number; phase: Phase; status?: "done" | "skipped" | "cut" }
    | { type: "pages.known"; at: number; known: number }
    | { type: "page.extracting"; at: number; page: string; extractor: string }
    | { type: "page.done"; at: number; done: number }
    | { type: "run.ended"; at: number; outcome: Exclude<Outcome, { status: "running" }> };

// An event before the run stamps its time.
export type Unstamped = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

// Done and known pages, the phase with its own count where it has one, and the ETA, as the scan runner writes them.
export interface Progress {
    done: number;
    total: number;
    phase: Phase;
    step?: { done: number; total: number };
    eta?: EtaSpan;
}

// A run with nothing done: every phase pending, the crawl first.
export function initialState(): RunState {
    return { phase: "crawl", phases: Object.fromEntries(PHASES.map((phase) => [phase, { status: "pending" }])) as Record<Phase, PhaseState>, pages: { done: 0, known: 0, samples: [], last: 0, origin: "" }, activity: { page: "", extractor: "", since: 0 }, outcome: { status: "running" } };
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

// Pages with the ETA worked out again from their samples.
function timed(pages: RunState["pages"]): RunState["pages"] {
    const { eta: _stale, ...rest } = pages;
    const range = eta(pages.samples, Math.max(pages.done, pages.known) - pages.done);
    return { ...rest, ...(range && { eta: etaSpan(range) }) };
}

// The state after `event`; never mutates `state`.
export function reduce(state: RunState, event: RunEvent): RunState {
    switch (event.type) {
        case "phase.started": {
            const phases = { ...state.phases, [event.phase]: { status: "running", started: event.at, ...(event.total !== undefined && { done: 0, total: event.total }) } };
            const isCrawl = event.phase === "crawl";
            const pages = isCrawl ? timed({ ...state.pages, samples: [], last: event.at, origin: event.origin ?? "" }) : state.pages;
            return { ...state, phase: event.phase, phases, pages, activity: { page: "", extractor: "", since: isCrawl ? 0 : event.at } };
        }
        case "phase.counted": {
            const phase = state.phases[event.phase];
            return phase.total === undefined ? state : { ...state, phases: { ...state.phases, [event.phase]: { ...phase, done: event.done } } };
        }
        case "phase.ended": {
            return { ...state, phases: { ...state.phases, [event.phase]: { ...state.phases[event.phase], status: event.status ?? "done", ended: event.at } } };
        }
        case "pages.known": {
            return { ...state, pages: timed({ ...state.pages, known: event.known }) };
        }
        case "page.extracting": {
            return { ...state, activity: { page: event.page, extractor: event.extractor, since: event.at } };
        }
        case "page.done": {
            const isNext = event.done - state.pages.done === 1;
            const samples = isNext ? [...state.pages.samples, (event.at - state.pages.last) / 1000].slice(-ETA_WINDOW) : state.pages.samples;
            return { ...state, pages: timed({ ...state.pages, done: event.done, samples, last: event.at }), activity: { page: "", extractor: "", since: 0 } };
        }
        case "run.ended": {
            return { ...state, outcome: event.outcome };
        }
    }
}

// What the scan runner writes for `state`: the page counts, the phase with its count, the ETA.
export function progressOf(state: RunState): Progress {
    const { done, known, eta: left } = state.pages;
    const { done: stepDone = 0, total } = state.phases[state.phase];
    return { done, total: Math.max(done, known), phase: state.phase, ...(total !== undefined && { step: { done: stepDone, total } }), ...(left && { eta: left }) };
}

// Hears every state change of a run it is handed to; `isDrawing` steps per-page logs down to debug.
export interface RunObserver {
    update(state: Readonly<RunState>, event: RunEvent): void;
    readonly isDrawing?: boolean;
}

// One run’s state, changed only by `emit`, which logs each event and hands the new state to the observer.
export class Run {
    #state = initialState();
    readonly #clock: () => number;
    readonly observer?: RunObserver;

    constructor(observer?: RunObserver, clock: () => number = Date.now) {
        this.observer = observer;
        this.#clock = clock;
    }

    get state(): Readonly<RunState> {
        return this.#state;
    }

    emit(event: Unstamped): void {
        const stamped = { ...event, at: this.#clock() } as RunEvent;
        log.debug(stamped, `run ${stamped.type}`);
        this.#state = reduce(this.#state, stamped);
        this.observer?.update(this.#state, stamped);
    }
}

// Whether `event` changes what a progress view draws: a step waits for the next redraw, a crawl’s start for its first page.
export function isRedrawn(event: RunEvent): boolean {
    return event.type !== "page.extracting" && !(event.type === "phase.started" && event.phase === "crawl");
}

// Writes `progressOf` on every change but a step, counts inside a phase at most four times a second and the last one always.
export function progressWriter(write: (progress: Progress) => void): RunObserver {
    const sent = { at: -Infinity };
    return {
        update(state, event) {
            if (!isRedrawn(event) || event.type === "phase.ended" || event.type === "run.ended") return;
            const total = event.type === "phase.counted" ? state.phases[event.phase].total : 0;
            if (total === undefined || (event.type === "phase.counted" && event.done < total && event.at - sent.at < COUNT_MS)) return;
            sent.at = event.at;
            write(progressOf(state));
        },
    };
}
