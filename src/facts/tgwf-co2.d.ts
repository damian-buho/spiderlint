// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// The slice of CO2.js 0.19 spiderlint calls; the package ships no types.
declare module "@tgwf/co2" {
    export class co2 {
        constructor(options: { model: "swd"; version: 4; rating: true });
        perVisit(bytes: number, isGreen?: boolean): { total: number; rating: string };
    }
}
