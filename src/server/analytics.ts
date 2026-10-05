// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Context } from "hono";
import { log } from "../logger.ts";

// A Matomo the server reports page views to: no script reaches the browser, so visits without JavaScript count and the page policy stays as it is.
export interface Matomo {
    // Its base URL; `matomo.php` is requested under it.
    url: string;
    siteId: number;
    // This instance’s public address, which the tracked URLs sit under.
    site: string;
    // The privacy statement the footer links to while this is on.
    privacy: string;
    // Whether a tracked title names the scanned host.
    isHostNamed: boolean;
}

const TIMEOUT_MS = 3000;
const PAUSE_MS = 60_000;
const NAMES: Record<string, string> = { "/": "Scan form", "/jobs/:id": "Scan report" };

// Tracking stays off until this time after a failure, so a down Matomo costs a page one timeout, not every page.
const pause = { until: 0, failures: 0 };

// Whether the visitor asked not to be tracked.
function isRefused(c: Context): boolean {
    return c.req.header("dnt") === "1" || c.req.header("sec-gpc") === "1";
}

// Reports the page `route` the visitor just got, without waiting for Matomo; the badge and the API never come here, and a visitor who sent DNT or Sec-GPC is not reported.
export function track(matomo: Matomo | undefined, c: Context, route: string, host?: string): void {
    if (!matomo) return;
    const name = NAMES[route];
    if (!name || c.req.method !== "GET" || Date.now() < pause.until || isRefused(c)) {
        log.debug({ route, method: c.req.method, isRefused: isRefused(c), isPaused: Date.now() < pause.until }, "page view not tracked");
        return;
    }
    const address = new URL("matomo.php", matomo.url);
    const parameters = {
        idsite: String(matomo.siteId),
        rec: "1",
        apiv: "1",
        send_image: "0",
        url: new URL(route, matomo.site).href,
        action_name: host && matomo.isHostNamed ? `${name}: ${host}` : name,
        ua: c.req.header("user-agent") ?? "",
        lang: c.req.header("accept-language") ?? "",
        rand: String(Math.random()).slice(2),
    };
    address.search = new URLSearchParams(parameters).toString();
    void fetch(address, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "manual" })
        .then((response) => {
            if (response.status >= 500) throw new Error(`answered ${response.status}`);
            pause.failures = 0;
            log.debug({ route, status: response.status }, "page view tracked");
            return response.status;
        })
        .catch((error: unknown) => {
            pause.failures += 1;
            pause.until = Date.now() + PAUSE_MS * Math.min(pause.failures, 10);
            log.warn({ route, failures: pause.failures, error: error instanceof Error ? error.message : String(error) }, "page view not tracked; tracking paused");
        });
}
