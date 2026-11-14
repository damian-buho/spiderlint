// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { logUpdateStderr } from "log-update";
import { relative } from "./crawl/scope.ts";
import { printAbove } from "./logger.ts";
import { isRedrawn, type EtaSpan, type Phase, type RunObserver, type RunState } from "./run.ts";

const BAR_WIDTH = 20;

// What each phase is called on the status line.
const PHASE_TEXT: Record<Phase, string> = { crawl: "crawling", resources: "linked resources", probes: "external links", site: "site checks", lint: "rules" };

// Phases the line clears after, as the run leaves the crawl, the network and the rules.
const CLEARS = new Set<Phase>(["crawl", "site", "lint"]);

const SUFFIX: Record<EtaSpan["unit"], string> = { second: "s", minute: "min", hour: "h" };

// The span as `ETA 2–4 min`, `ETA under 3 min` while the low end is zero, one value when both ends meet.
export function etaText(span: EtaSpan | undefined): string {
    if (!span) return "";
    const { low, high, unit } = span;
    if (low === high) return `ETA ${high} ${SUFFIX[unit]}`;
    return low === 0 ? `ETA under ${high} ${SUFFIX[unit]}` : `ETA ${low}–${high} ${SUFFIX[unit]}`;
}

// What the run is at: the page in flight while crawling, else the phase with its count.
function where(state: RunState): string {
    if (state.phase === "crawl") return relative(state.activity.page, state.pages.origin);
    const { done = 0, total } = state.phases[state.phase];
    return `${PHASE_TEXT[state.phase]}${total === undefined ? "" : ` ${done}/${total}`}`;
}

// The line as drawn at `now`: a bar, done/known, the ETA, the extractor, the page, seconds on it.
export function line(state: RunState, now: number): string {
    const { done, known, eta } = state.pages;
    const total = Math.max(done, known);
    const filled = total > 0 ? Math.min(BAR_WIDTH, Math.round((done / total) * BAR_WIDTH)) : 0;
    const { extractor, since } = state.activity;
    const seconds = since > 0 ? `${Math.round((now - since) / 1000)} s` : "";
    return [`▕${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}▏`, `${done}/${total}`, etaText(eta), extractor, where(state), seconds].filter(Boolean).join(" ");
}

// The terminal status line: shown from a phase’s start to the next clearing end, redrawn on every change `isRedrawn` names, with log lines printed above it.
export function statusLine(): RunObserver {
    const drawn = { state: undefined as RunState | undefined };
    const draw = () => {
        if (drawn.state) logUpdateStderr(line(drawn.state, Date.now()));
    };
    const print = (text: string) => {
        logUpdateStderr.persist(text);
        draw();
    };
    const hide = () => {
        if (!drawn.state) return;
        logUpdateStderr.clear();
        logUpdateStderr.done();
        drawn.state = undefined;
        printAbove(undefined);
    };
    return {
        isDrawing: true,
        update(state, event) {
            if ((event.type === "phase.ended" && CLEARS.has(event.phase)) || event.type === "run.ended") return hide();
            if (event.type === "phase.started") printAbove(print);
            if (event.type === "phase.started" || drawn.state) drawn.state = state;
            if (isRedrawn(event)) draw();
        },
    };
}
