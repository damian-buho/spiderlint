// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Finding, Severity } from "./types.ts";

export type Level = Exclude<Severity, "off">;
// Points of a dynamic score: the measured value, then the score it earns; read between the points.
export type Scale = [value: number, score: number][];

// Each level’s lowest and highest score in tenths, and the score a level alone stands for.
const BANDS: Record<Level, { min: number; max: number; base: number }> = {
    hint: { min: 0, max: 0.9, base: 0.5 },
    info: { min: 1, max: 3.2, base: 2 },
    warning: { min: 3.3, max: 6.5, base: 5 },
    error: { min: 6.6, max: 9.9, base: 8 },
};
const LEVELS: Level[] = ["error", "warning", "info", "hint"];

// A score on the one-decimal grid, 0.0 to 9.9.
export function round(score: number): number {
    return Math.min(9.9, Math.max(0, Math.round(score * 10) / 10));
}

// The level whose band holds the score.
export function levelOf(score: number): Level {
    const tenths = round(score);
    return LEVELS.find((level) => tenths >= BANDS[level].min) ?? "hint";
}

// The score a rule gets for a level alone.
export function baseScore(level: Level): number {
    return BANDS[level].base;
}

// The score moved into a level’s band, so a pinned level never leaves it.
export function pin(level: Level, score: number): number {
    return Math.min(BANDS[level].max, Math.max(BANDS[level].min, round(score)));
}

// The score between the two scale points around `value`, flat beyond the ends.
export function interpolate(scale: Scale, value: number): number {
    const points = scale.toSorted(([a], [b]) => a - b);
    const at = Math.min(Math.max(value, (points[0] as [number, number])[0]), (points.at(-1) as [number, number])[0]);
    const index = Math.max(
        1,
        points.findIndex(([x]) => x >= at),
    );
    const [x0, y0] = points[index - 1] as [number, number];
    const [x1, y1] = points[index] as [number, number];
    return round(y0 + ((y1 - y0) * (at - x0)) / (x1 - x0));
}

// A finding’s score, the level’s base when no rule computed one.
export function scoreOf(finding: Pick<Finding, "score" | "severity">): number {
    return finding.score ?? BANDS[finding.severity].base;
}

// What a failed check costs the rating: 1 at the warning base, rising with the square of the score.
export function weight(score: number): number {
    return (score / BANDS.warning.base) ** 2;
}

// Pages the finding touches: its folded count or listed URLs, else the whole site for a site-wide one, else one.
export function pagesOf(finding: Finding, total: number): number {
    return finding.occurrences ?? finding.urls?.length ?? (finding.scope === "site" ? total : 1);
}

// Score times the pages the finding touches.
export function impact(finding: Finding, total: number): number {
    return scoreOf(finding) * pagesOf(finding, total);
}

// Score times the share of the site’s pages the finding touches; a site-wide finding touches all of them.
export function importance(finding: Finding, total: number): number {
    return scoreOf(finding) * (total === 0 ? 1 : Math.min(1, pagesOf(finding, total) / total));
}

// Orders findings from the most to the least important, then by rule and URL.
export function byImportance(total: number): (a: Finding, b: Finding) => number {
    return (a, b) => importance(b, total) - importance(a, total) || a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url);
}
