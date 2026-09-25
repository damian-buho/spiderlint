// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export type Grade = "S" | "A" | "B" | "C" | "D" | "E" | "F";

export interface Checks {
    total: number;
    passed: number;
    failed: number;
    errored: number;
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

// Grade by share passed; S needs no failed check, an error caps at B, nothing judged means no grade.
export function rate(checks: Checks, rulesets: string[]): Rating | undefined {
    if (checks.total === 0) return undefined;
    const floors = checks.errored > 0 ? FLOORS.slice(1) : FLOORS;
    const grade = checks.failed === 0 ? "S" : (floors.find(([tenths]) => checks.passed * 10 >= tenths * checks.total)?.[1] ?? "F");
    return { grade, score: Number((checks.passed / checks.total).toFixed(4)), rulesets };
}
