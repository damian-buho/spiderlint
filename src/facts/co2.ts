// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { Co2Facts, Facts } from "./types.ts";

// The model every estimate names, so two runs compare: Sustainable Web Design v4 through CO2.js 0.19.0.
const MODEL = { model: "swd", version: 4, library: "@tgwf/co2 0.19.0" } as const;

type Estimator = InstanceType<(typeof import("@tgwf/co2"))["co2"]>;

// The estimator once loaded; absent until a run needs it.
const loaded: { estimator?: Estimator } = {};

// Loads CO2.js once, only for a run whose rules read `co2`.
export async function loadEstimator(): Promise<void> {
    const module = loaded.estimator ? undefined : await import("@tgwf/co2");
    if (module) loaded.estimator = new module.co2({ model: MODEL.model, version: MODEL.version, rating: true });
    log.debug({ ...MODEL, isFresh: module !== undefined }, "co2 estimator loaded");
}

// Grams of CO2e per view of a page: its own transfer size plus each distinct resource it loaded, hosting counted as not green until the green check lands.
export function co2Facts(page: Facts): Co2Facts | undefined {
    if (!loaded.estimator) return undefined;
    const sizes = new Map((page.resources ?? []).flatMap((resource) => (resource.http?.size.body === undefined ? [] : [[resource.url, resource.http.size.body] as const])));
    const resources = sizes.values().reduce((sum, bytes) => sum + bytes, 0);
    const bytes = page.http.size.body + resources;
    const { total, rating } = loaded.estimator.perVisit(bytes, false);
    const grams = Math.round(total * 10_000) / 10_000;
    log.debug({ url: page.url.href, bytes, resources: sizes.size, grams, rating }, "co2 estimated");
    return { ...MODEL, bytes, resources: sizes.size, grams, rating };
}
