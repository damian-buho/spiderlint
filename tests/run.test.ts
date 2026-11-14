// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { eta, etaSpan, initialState, isRedrawn, isSettledBy, PHASES, phasesOf, progressWriter, reduce, Run, waitsFor, type Plan, type RunEvent, type RunLine, type RunObserver, type RunState } from "../src/run.ts";
import { runRules, type PageResults } from "../src/rules/run.ts";
import type { AggregateRule, PageRule } from "../src/rules/types.ts";
import type { Facts, SiteFacts } from "../src/facts/types.ts";
import type { Report } from "../src/index.ts";
import { etaText, line } from "../src/status-line.ts";

// The state after `events`, applied in order to a fresh run.
function after(events: RunEvent[]): RunState {
    let state = initialState();
    for (const event of events) state = reduce(state, event);
    return state;
}

// Pages 1 to `count`, page n finished at second n.
function pagesDone(count: number): RunEvent[] {
    return Array.from({ length: count }, (_, index) => ({ type: "page.done", at: (index + 1) * 1000, done: index + 1 }));
}

describe("run ETA", () => {
    it("stays silent until enough pages are sampled or nothing is left", () => {
        assert.equal(eta([1, 1], 10), undefined);
        assert.equal(eta([1, 1, 1], 0), undefined);
    });

    it("collapses to a point when every gap is equal", () => {
        assert.deepEqual(eta([2, 2, 2], 30), [60, 60]);
    });

    it("brackets the mean and narrows as the window fills", () => {
        const few = eta([1, 3, 2], 100);
        const many = eta(Array.from({ length: 16 }, () => [1, 3, 2]).flat(), 100);
        assert.ok(few);
        assert.ok(many);
        assert.ok(few[0] < 200 && few[1] > 200);
        assert.ok(many[1] - many[0] < few[1] - few[0]);
        assert.ok(few[0] >= 0);
    });

    it("prints one unit when both ends share it", () => {
        assert.equal(etaText(undefined), "");
        assert.equal(etaText(etaSpan([12.4, 40.2])), "ETA 12–41 s");
        assert.equal(etaText(etaSpan([150, 250])), "ETA 2–5 min");
        assert.equal(etaText(etaSpan([45, 130])), "ETA under 3 min");
        assert.equal(etaText(etaSpan([3000, 7300])), "ETA under 3 h");
        assert.equal(etaText(etaSpan([60, 60])), "ETA 1 min");
    });

    it("rounds to whole numbers in the unit the high end reaches, switching to minutes past 60 s", () => {
        assert.deepEqual(etaSpan([0, 61.369]), { low: 0, high: 2, unit: "minute" });
        assert.deepEqual(etaSpan([12.4, 40.2]), { low: 12, high: 41, unit: "second" });
        assert.deepEqual(etaSpan([150, 250]), { low: 2, high: 5, unit: "minute" });
        assert.deepEqual(etaSpan([7300, 9000]), { low: 2, high: 3, unit: "hour" });
        for (const range of [
            [0.2, 59.1],
            [3.3, 3599.9],
            [1, 90_000],
        ] as [number, number][]) {
            const { low, high } = etaSpan(range);
            assert.ok(Number.isSafeInteger(low) && Number.isSafeInteger(high), String(range));
        }
    });
});

const PLAN: Plan = { rulesets: ["links"], groups: { default: ["links/external/unreachable", "seo/title/missing"] }, rules: { "links/external/unreachable": ["crawl", "probes"], "seo/title/missing": ["crawl"] } };

describe("run plan", () => {
    it("waits for the later phase of a rule reading facts from two", () => {
        const phases = phasesOf(["site.links", "html.links.external"]);
        assert.deepEqual(phases, ["crawl", "probes"]);
        assert.equal(waitsFor(phases), "probes");
    });

    it("matches a fact family on a whole path segment, and reads no fact as the crawl", () => {
        assert.deepEqual(phasesOf(["resources"]), ["resources"]);
        assert.deepEqual(phasesOf(["resources.length"]), ["resources"]);
        assert.deepEqual(phasesOf(["resourcesx"]), ["crawl"]);
        assert.deepEqual(phasesOf(["site.origins.dns.mx"]), ["site"]);
        assert.deepEqual(phasesOf(["site.redirects"]), ["crawl"]);
        assert.deepEqual(phasesOf(["graph.prev", "site.hosts"]), ["site", "lint"]);
        assert.equal(waitsFor(phasesOf([])), "crawl");
    });

    it("completes CO2 with the resources, whose sizes it adds", () => {
        assert.deepEqual(phasesOf(["co2.grams"]), ["resources"]);
    });

    it("settles a rule once its last phase ends, not one phase before", () => {
        assert.equal(isSettledBy(["crawl", "resources"], "crawl"), false);
        assert.equal(isSettledBy(["crawl", "resources"], "resources"), true);
        assert.equal(isSettledBy(["crawl", "resources"], "probes"), true);
        assert.equal(isSettledBy([], "crawl"), true);
        assert.equal(isSettledBy(["lint"], "site"), false);
    });

    it("keeps the plan a run starts with", () => {
        assert.equal(initialState().plan, undefined);
        assert.deepEqual(after([{ type: "run.planned", at: 0, plan: PLAN }]).plan, PLAN);
    });
});

describe("run reducer", () => {
    it("starts with every phase pending and the run going", () => {
        const state = initialState();
        assert.deepEqual(PHASES, ["crawl", "resources", "probes", "site", "lint"]);
        assert.ok(PHASES.every((phase) => state.phases[phase].status === "pending"));
        assert.deepEqual(state.outcome, { status: "running" });
    });

    it("never changes the state it is given", () => {
        const before = after([{ type: "phase.started", at: 0, phase: "crawl", origin: "https://a.test" }]);
        const copy = structuredClone(before);
        reduce(before, { type: "page.done", at: 1000, done: 1 });
        reduce(before, { type: "phase.ended", at: 1000, phase: "crawl" });
        assert.deepEqual(before, copy);
    });

    it("gives an ETA from the third consecutive page on, not the second", () => {
        const start: RunEvent[] = [
            { type: "phase.started", at: 0, phase: "crawl" },
            { type: "pages.known", at: 0, known: 10 },
        ];
        assert.equal(after([...start, ...pagesDone(2)]).pages.eta, undefined);
        assert.deepEqual(after([...start, ...pagesDone(3)]).pages.eta, { low: 7, high: 7, unit: "second" });
    });

    it("samples only a page that follows the last one, so a resumed jump moves the baseline alone", () => {
        const state = after([
            { type: "phase.started", at: 0, phase: "crawl" },
            { type: "page.done", at: 1000, done: 1 },
            { type: "page.done", at: 9000, done: 5 },
            { type: "page.done", at: 10_000, done: 6 },
        ]);
        assert.deepEqual(state.pages.samples, [1, 1]);
        assert.equal(state.pages.last, 10_000);
    });

    it("keeps the newest 50 gaps and drops the 51st oldest", () => {
        const fifty = after([{ type: "phase.started", at: 0, phase: "crawl" }, ...pagesDone(50)]);
        const fiftyOne = reduce(fifty, { type: "page.done", at: 52_000, done: 51 });
        assert.equal(fifty.pages.samples.length, 50);
        assert.equal(fiftyOne.pages.samples.length, 50);
        assert.equal(fiftyOne.pages.samples.at(-1), 2);
    });

    it("counts done pages as known when the frontier knows fewer, and has no ETA once nothing is left", () => {
        const state = after([{ type: "phase.started", at: 0, phase: "crawl" }, ...pagesDone(4), { type: "pages.known", at: 5000, known: 3 }]);
        assert.equal(state.pages.eta, undefined);
        assert.equal(line(state, 5000), "▕████████████████████▏ 4/4");
    });

    it("forgets the samples and takes the origin when a crawl starts again", () => {
        const state = after([{ type: "phase.started", at: 0, phase: "crawl" }, ...pagesDone(3), { type: "phase.started", at: 9000, phase: "crawl", origin: "https://b.test" }]);
        assert.deepEqual(state.pages.samples, []);
        assert.equal(state.pages.last, 9000);
        assert.equal(state.pages.origin, "https://b.test");
    });

    it("counts inside a phase only when the phase has a total", () => {
        const lint = after([
            { type: "phase.started", at: 0, phase: "lint" },
            { type: "phase.counted", at: 1, phase: "lint", done: 3 },
        ]);
        const site = after([
            { type: "phase.started", at: 0, phase: "site", total: 4 },
            { type: "phase.counted", at: 1, phase: "site", done: 3 },
        ]);
        assert.equal(lint.phases.lint.done, undefined);
        assert.deepEqual(site.phases.site, { status: "running", started: 0, done: 3, total: 4 });
    });

    it("ends a phase done unless it says cut or skipped, and the run with its outcome", () => {
        const state = after([
            { type: "phase.started", at: 0, phase: "crawl" },
            { type: "phase.ended", at: 5, phase: "crawl" },
            { type: "phase.ended", at: 6, phase: "resources", status: "skipped" },
            { type: "phase.started", at: 7, phase: "site", total: 2 },
            { type: "phase.ended", at: 8, phase: "site", status: "cut" },
            { type: "run.ended", at: 9, outcome: { status: "incomplete", reason: "analysis-timeout" } },
        ]);
        assert.deepEqual(state.phases.crawl, { status: "done", started: 0, ended: 5 });
        assert.equal(state.phases.resources.status, "skipped");
        assert.equal(state.phases.site.status, "cut");
        assert.equal(state.phases.probes.status, "pending");
        assert.deepEqual(state.outcome, { status: "incomplete", reason: "analysis-timeout" });
    });

    it("names the extractor in flight until its page is done", () => {
        const extracting = after([
            { type: "phase.started", at: 0, phase: "crawl" },
            { type: "page.extracting", at: 2000, page: "https://a.test/x", extractor: "html" },
        ]);
        assert.deepEqual(extracting.activity, { page: "https://a.test/x", extractor: "html", since: 2000 });
        assert.deepEqual(reduce(extracting, { type: "page.done", at: 3000, done: 1 }).activity, { page: "", extractor: "", since: 0 });
    });
});

describe("run rules", () => {
    it("starts with no cell settled", () => {
        assert.deepEqual(initialState().rules, {});
    });

    it("stamps each verdict with the phase that settled it and keeps the earlier ones", () => {
        const state = after([
            { type: "rules.checked", at: 0, phase: "crawl", cells: { default: { "seo/title/missing": { status: "passed" } } } },
            { type: "rules.checked", at: 1, phase: "probes", cells: { default: { "links/external/unreachable": { status: "findings", findings: { error: 2 } } }, posts: { "seo/title/missing": { status: "untested" } } } },
        ]);
        assert.deepEqual(state.rules, {
            default: { "seo/title/missing": { status: "passed", phase: "crawl" }, "links/external/unreachable": { status: "findings", findings: { error: 2 }, phase: "probes" } },
            posts: { "seo/title/missing": { status: "untested", phase: "probes" } },
        });
    });

    it("keeps the newest partial report, and the earlier one when a settling carries none", () => {
        const [first, second] = [{ summary: { pages: 1 } }, { summary: { pages: 2 } }] as unknown as Report[];
        const kept = after([
            { type: "rules.checked", at: 0, phase: "crawl", cells: {}, partial: first },
            { type: "rules.checked", at: 1, phase: "resources", cells: {}, partial: second },
        ]);
        assert.equal(kept.partial, second);
        assert.equal(reduce(kept, { type: "rules.checked", at: 2, phase: "lint", cells: {} }).partial, second);
        assert.equal(initialState().partial, undefined);
    });

    it("never changes the state it is given when a cell settles", () => {
        const before = after([{ type: "rules.checked", at: 0, phase: "crawl", cells: { default: { a: { status: "passed" } } } }]);
        const copy = structuredClone(before);
        reduce(before, { type: "rules.checked", at: 1, phase: "lint", cells: { default: { b: { status: "passed" } } } });
        assert.deepEqual(before, copy);
    });

    it("leaves the status line alone when a cell settles", () => {
        assert.equal(isRedrawn({ type: "rules.checked", at: 0, phase: "crawl", cells: {} }), false);
    });
});

// A page of `group` at `href`.
function factsOf(href: string, group: string): Facts {
    const url = new URL(href);
    return {
        url: { href, origin: url.origin, protocol: url.protocol, host: url.host, pathname: url.pathname, search: "" },
        group,
        crawl: { depth: 0, "discovered-via": "seed", referrers: [] },
        http: { status: 200, redirects: [], headers: {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, "content-type": "text/html" },
    };
}

// A page rule that counts its checks, finding a warning on `/bad` and skipping `/skip`.
function countingRule(calls: { count: number }): PageRule {
    return {
        meta: { id: "test/page", severity: "warning", scope: "page", facts: [] },
        check(page) {
            calls.count += 1;
            if (page.url.pathname === "/skip") return;
            return page.url.pathname === "/bad" ? [{ rule: "test/page", severity: "warning", scope: "page", url: page.url.href, message: "bad" }] : [];
        },
    };
}

describe("rule verdicts", () => {
    const pages = [factsOf("https://a.test/", "default"), factsOf("https://a.test/bad", "default"), factsOf("https://a.test/skip", "quiet"), factsOf("https://a.test/ok", "clean")];
    const site: AggregateRule = { meta: { id: "test/site", severity: "error", scope: "site", facts: [] }, check: () => [{ rule: "test/site", severity: "error", scope: "site", url: "https://a.test/", message: "site" }] };

    it("passes a cell with no finding, counts findings by severity, and leaves untested a cell nothing applied to", () => {
        const rule = countingRule({ count: 0 });
        const run = runRules(
            pages,
            new Map([
                ["default", [rule, site]],
                ["quiet", [rule]],
                ["clean", [rule, site]],
            ]),
            {} as SiteFacts,
        );
        assert.deepEqual(run.verdicts.get("default\ttest/page"), { status: "findings", findings: { warning: 1 } });
        assert.deepEqual(run.verdicts.get("quiet\ttest/page"), { status: "untested" });
        assert.deepEqual(run.verdicts.get("clean\ttest/page"), { status: "passed" });
        assert.deepEqual(run.verdicts.get("clean\ttest/site"), { status: "findings", findings: { error: 1 } });
        assert.equal(run.verdicts.get("default\ttest/site")?.status, "findings");
    });

    it("replays a page rule it already checked, to the same findings, checks and cost", () => {
        const calls = { count: 0 };
        const rule = countingRule(calls);
        const groups = new Map([
            ["default", [rule]],
            ["quiet", [rule]],
        ]);
        const results: PageResults = new Map();
        const first = runRules(pages, groups, {} as SiteFacts, results);
        const checked = calls.count;
        const again = runRules(pages, groups, {} as SiteFacts, results);
        assert.equal(checked, 3);
        assert.equal(calls.count, checked);
        assert.deepEqual(again, first);
    });
});

describe("run observer", () => {
    it("hands each stamped event and the state after it to the observer, one state per run", () => {
        const heard: [RunState, RunEvent][] = [];
        const recorder: RunObserver = {
            update: (state, event) => {
                heard.push([state, event]);
            },
        };
        const ticks = [100, 200];
        const run = new Run(recorder, () => ticks.shift() ?? 0);
        const other = new Run(recorder, () => 0);
        run.emit({ type: "phase.started", phase: "crawl" });
        run.emit({ type: "page.done", done: 1 });
        assert.deepEqual(
            heard.map(([, event]) => event),
            [
                { type: "phase.started", phase: "crawl", at: 100 },
                { type: "page.done", done: 1, at: 200 },
            ],
        );
        assert.equal(heard.at(-1)?.[0], run.state);
        assert.equal(run.state.pages.done, 1);
        assert.equal(other.state.pages.done, 0);
    });
});

// Every progress the writer sends for `events`, through a run whose clock reads each event’s own `at`.
function written(events: (RunEvent extends infer E ? (E extends RunEvent ? Omit<E, "at"> & { at: number } : never) : never)[]): RunLine[] {
    const sent: RunLine[] = [];
    const clock = { at: 0 };
    const run = new Run(
        progressWriter((progress) => {
            sent.push(progress);
        }),
        () => clock.at,
    );
    for (const { at, ...event } of events) {
        clock.at = at;
        run.emit(event);
    }
    return sent;
}

// The progress lines among `lines`, without the plan.
function progressOnly(lines: RunLine[]) {
    return lines.flatMap((line) => ("plan" in line ? [] : [line]));
}

describe("progress writer", () => {
    it("writes the plan once as its own line, before any progress", () => {
        const sent = written([{ type: "run.planned", at: 0, plan: PLAN }, { type: "phase.started", at: 0, phase: "crawl" }, ...pagesDone(1)]);
        assert.deepEqual(sent[0], { plan: PLAN });
        assert.equal(sent.filter((line) => "plan" in line).length, 1);
        assert.equal(sent.length, 2);
    });

    it("writes every finished page but not the crawl’s start, with the ETA once enough are sampled", () => {
        const sent = progressOnly(written([{ type: "phase.started", at: 0, phase: "crawl" }, ...pagesDone(4)]));
        assert.deepEqual(
            sent.map((progress) => progress.done),
            [1, 2, 3, 4],
        );
        assert.equal(sent.at(-1)?.total, 4);
        assert.equal(sent[0]?.eta, undefined);
    });

    it("writes each phase as it starts with its count, and never a step, a phase end or the run end", () => {
        const sent = progressOnly(
            written([
                { type: "page.done", at: 0, done: 10 },
                ...PHASES.slice(1).map((phase, index) => ({ type: "phase.started" as const, at: index + 1, phase, ...(phase !== "lint" && { total: 2 }) })),
                { type: "page.extracting", at: 10, page: "https://a.test/", extractor: "html" },
                { type: "phase.ended", at: 11, phase: "lint" },
                { type: "run.ended", at: 12, outcome: { status: "finished" } },
            ]),
        );
        assert.deepEqual(
            sent.map((progress) => progress.phase),
            ["crawl", "resources", "probes", "site", "lint"],
        );
        assert.deepEqual(sent[1]?.step, { done: 0, total: 2 });
        assert.equal(sent[4]?.step, undefined);
    });

    it("writes a count 250 ms after the last write but not at 249 ms, and the last count always", () => {
        const sent = progressOnly(
            written([
                { type: "phase.started", at: 0, phase: "resources", total: 3 },
                { type: "phase.counted", at: 249, phase: "resources", done: 1 },
                { type: "phase.counted", at: 250, phase: "resources", done: 2 },
                { type: "phase.counted", at: 251, phase: "resources", done: 3 },
            ]),
        );
        assert.deepEqual(
            sent.map((progress) => progress.step?.done),
            [0, 2, 3],
        );
    });

    it("writes the settled cells with every progress after the first settles, and none before", () => {
        const sent = progressOnly(written([{ type: "phase.started", at: 0, phase: "resources", total: 1 }, { type: "rules.checked", at: 1, phase: "crawl", cells: { default: { a: { status: "passed" } } } }, ...pagesDone(1)]));
        assert.equal(sent[0]?.rules, undefined);
        assert.deepEqual(sent[1]?.rules, { default: { a: { status: "passed", phase: "crawl" } } });
        assert.deepEqual(sent[2]?.rules, sent[1]?.rules);
    });

    it("writes no count for a phase without a total", () => {
        const sent = progressOnly(
            written([
                { type: "phase.started", at: 0, phase: "lint" },
                { type: "phase.counted", at: 1000, phase: "lint", done: 1 },
            ]),
        );
        assert.equal(sent.length, 1);
    });
});

describe("status line", () => {
    it("draws the bar, the counts, the ETA, the extractor, the page past the origin and seconds on it while crawling", () => {
        const state = after([{ type: "phase.started", at: 0, phase: "crawl", origin: "https://a.test" }, { type: "pages.known", at: 0, known: 10 }, ...pagesDone(5), { type: "page.extracting", at: 6000, page: "https://a.test/about", extractor: "html" }]);
        assert.equal(line(state, 9000), "▕██████████░░░░░░░░░░▏ 5/10 ETA 5 s html /about 3 s");
    });

    it("draws the phase with its count and seconds in it after the crawl", () => {
        const state = after([...pagesDone(1), { type: "phase.started", at: 1000, phase: "resources", total: 10 }, { type: "phase.counted", at: 2000, phase: "resources", done: 3 }]);
        assert.equal(line(state, 3000), "▕████████████████████▏ 1/1 linked resources 3/10 2 s");
        assert.equal(line(reduce(state, { type: "phase.started", at: 3000, phase: "lint" }), 3000), "▕████████████████████▏ 1/1 rules 0 s");
    });
});
