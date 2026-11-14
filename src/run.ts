// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Report } from "./index.ts";
import { log } from "./logger.ts";
import type { Finding } from "./rules/types.ts";

const ETA_WINDOW = 50;
const ETA_MIN_SAMPLES = 3;
const ETA_Z = 2;
const COUNT_MS = 250;

// What a run does, in order: the crawl, then the work on its pages, then the rules.
export const PHASES = ["crawl", "resources", "probes", "site", "lint"] as const;
export type Phase = (typeof PHASES)[number];

// The phase that completes each fact family, matched by prefix; any other fact is complete with the crawl.
const FACT_PHASES: [prefix: string, phase: Phase][] = [
    ["resources", "resources"],
    ["co2", "resources"],
    ["site.links", "probes"],
    ["site.origins", "site"],
    ["site.hosts", "site"],
    ["site.linked", "site"],
    ["site.graph", "lint"],
    ["graph", "lint"],
];

// What a run will check: its rulesets, each group’s rule IDs and the phases each rule reads facts from.
export interface Plan {
    rulesets: string[];
    groups: Record<string, string[]>;
    rules: Record<string, Phase[]>;
}

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
    plan?: Plan;
    phase: Phase;
    phases: Record<Phase, PhaseState>;
    pages: { done: number; known: number; eta?: EtaSpan; samples: number[]; last: number; origin: string };
    activity: { page: string; extractor: string; since: number };
    // Each settled cell’s verdict and the phase that settled it; a cell absent here is waiting.
    rules: Record<string, Record<string, Verdict & { phase: Phase }>>;
    // The newest report over the settled cells, when the observer keeps one.
    partial?: Report;
    outcome: Outcome;
}

// The only ways a run changes its state, each stamped `at` in epoch ms.
export type RunEvent =
    | { type: "run.planned"; at: number; plan: Plan }
    | { type: "phase.started"; at: number; phase: Phase; total?: number; origin?: string }
    | { type: "phase.counted"; at: number; phase: Phase; done: number }
    | { type: "phase.ended"; at: number; phase: Phase; status?: "done" | "skipped" | "cut" }
    | { type: "pages.known"; at: number; known: number }
    | { type: "page.extracting"; at: number; page: string; extractor: string }
    | { type: "page.done"; at: number; done: number }
    | { type: "rules.checked"; at: number; phase: Phase; cells: Cells; partial?: Report }
    | { type: "run.ended"; at: number; outcome: Exclude<Outcome, { status: "running" }> };

// An event before the run stamps its time.
export type Unstamped = RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> : never) : never;

// The phases that complete `facts`, in run order.
export function phasesOf(facts: readonly string[]): Phase[] {
    const read = new Set(facts.map((fact) => FACT_PHASES.find(([prefix]) => fact === prefix || fact.startsWith(`${prefix}.`))?.[1] ?? "crawl"));
    return PHASES.filter((phase) => read.has(phase));
}

// The phase after which a rule reading from `phases` has all its facts: the last one.
export function waitsFor(phases: readonly Phase[]): Phase {
    return phases.at(-1) ?? "crawl";
}

// Whether a rule reading from `phases` has all its facts once `phase` ends.
export function isSettledBy(phases: readonly Phase[], phase: Phase): boolean {
    return PHASES.indexOf(waitsFor(phases)) <= PHASES.indexOf(phase);
}

// What one (group, rule) cell came to: passed, findings by severity, or nothing it applied to.
export interface Verdict {
    status: "passed" | "findings" | "untested";
    findings?: Partial<Record<Finding["severity"], number>>;
}

// Verdicts by group, then rule ID.
export type Cells = Record<string, Record<string, Verdict>>;

// Done and known pages, the phase with its own count where it has one, and the ETA, as the scan runner writes them.
export interface Progress {
    done: number;
    total: number;
    phase: Phase;
    step?: { done: number; total: number };
    eta?: EtaSpan;
    rules?: RunState["rules"];
}

// A run with nothing done: every phase pending, the crawl first.
export function initialState(): RunState {
    return { phase: "crawl", phases: Object.fromEntries(PHASES.map((phase) => [phase, { status: "pending" }])) as Record<Phase, PhaseState>, pages: { done: 0, known: 0, samples: [], last: 0, origin: "" }, activity: { page: "", extractor: "", since: 0 }, rules: {}, outcome: { status: "running" } };
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
        case "run.planned": {
            return { ...state, plan: event.plan };
        }
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
        case "rules.checked": {
            const rules = { ...state.rules };
            for (const [group, verdicts] of Object.entries(event.cells)) rules[group] = { ...rules[group], ...Object.fromEntries(Object.entries(verdicts).map(([id, verdict]) => [id, { ...verdict, phase: event.phase }])) };
            return { ...state, rules, ...(event.partial && { partial: event.partial }) };
        }
        case "run.ended": {
            return { ...state, outcome: event.outcome };
        }
    }
}

// What the scan runner writes for `state`: the page counts, the phase with its count, the ETA and the settled cells.
export function progressOf(state: RunState): Progress {
    const { done, known, eta: left } = state.pages;
    const { done: stepDone = 0, total } = state.phases[state.phase];
    return { done, total: Math.max(done, known), phase: state.phase, ...(total !== undefined && { step: { done: stepDone, total } }), ...(left && { eta: left }), ...(Object.keys(state.rules).length > 0 && { rules: state.rules }) };
}

// Hears every state change of a run it is handed to; `isDrawing` steps per-page logs down to debug, `isKeepingPartial` asks for a partial report at each settling.
export interface RunObserver {
    update(state: Readonly<RunState>, event: RunEvent): void;
    readonly isDrawing?: boolean;
    readonly isKeepingPartial?: boolean;
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
        const { partial, ...fields } = stamped as RunEvent & { partial?: Report };
        log.debug(partial ? { ...fields, partial: { pages: partial.summary.pages, findings: partial.summary.findings.total } } : fields, `run ${stamped.type}`);
        this.#state = reduce(this.#state, stamped);
        this.observer?.update(this.#state, stamped);
    }
}

// Whether `event` changes what the status line draws: a step waits for the next redraw, a crawl’s start for its first page, settled rules are not drawn.
export function isRedrawn(event: RunEvent): boolean {
    return event.type !== "page.extracting" && event.type !== "rules.checked" && !(event.type === "phase.started" && event.phase === "crawl");
}

// One line a scan runner writes: the plan once, then progress.
export type RunLine = Progress | { plan: Plan };

// Writes the plan once, then `progressOf` on every redrawn change and every settling, counts inside a phase at most four times a second and the last one always.
export function progressWriter(write: (line: RunLine) => void): RunObserver {
    const sent = { at: -Infinity };
    return {
        update(state, event) {
            if (event.type === "run.planned") return write({ plan: event.plan });
            if (!(isRedrawn(event) || event.type === "rules.checked") || event.type === "phase.ended" || event.type === "run.ended") return;
            const total = event.type === "phase.counted" ? state.phases[event.phase].total : 0;
            if (total === undefined || (event.type === "phase.counted" && event.done < total && event.at - sent.at < COUNT_MS)) return;
            sent.at = event.at;
            write(progressOf(state));
        },
    };
}
