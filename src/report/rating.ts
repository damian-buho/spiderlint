// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export type Grade = "S" | "A" | "B" | "C" | "D" | "E" | "F";

export interface Checks {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    // What the failed checks cost, each by its worst score; the failed count when absent.
    cost?: number;
}

// What one rule judged: checks run, checks failed, and the pages those checks covered.
export interface RuleChecks {
    checks: number;
    failed: number;
    pages: number;
}

// The rules that ran and failed nowhere, by ID.
export function passing(checked: Record<string, RuleChecks> = {}): [string, RuleChecks][] {
    return Object.entries(checked)
        .filter(([, rule]) => rule.failed === 0)
        .toSorted(([a], [b]) => a.localeCompare(b));
}

export interface Rating {
    grade: Grade;
    score: number;
    rulesets: string[];
}

// Lowest score in tenths each grade still reaches, best first; F takes the rest.
const FLOORS: [number, Grade][] = [
    [9, "A"],
    [7, "B"],
    [6, "C"],
    [4, "D"],
    [2, "E"],
];

// Grade by share passed, a failed check counting for its cost, 1 at a warning and more as its score rises; S needs no failed check, an error caps at B, nothing judged means no grade.
export function rate(checks: Checks, rulesets: string[]): Rating | undefined {
    if (checks.total === 0) return undefined;
    const floors = checks.errored > 0 ? FLOORS.slice(1) : FLOORS;
    const share = Math.max(0, checks.total - (checks.cost ?? checks.failed)) / checks.total;
    const grade = checks.failed === 0 ? "S" : (floors.find(([tenths]) => share * 10 >= tenths)?.[1] ?? "F");
    return { grade, score: Number(share.toFixed(4)), rulesets };
}
