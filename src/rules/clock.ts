// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { said } from "./message.ts";
import type { Finding, Make } from "./types.ts";

// Seconds a host’s clock may drift before it is a warning, and before it is an error.
const TOLERATED = 60;
const BROKEN = 3600;
// Seconds by which hosts that all skew alike may still disagree when the fault is our own clock.
const SPREAD = 5;

// The middle value of a non-empty list.
function median(values: number[]): number {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] as number;
}

// Two or more hosts off by nearly the same amount in the same direction.
export function isOwnClock(skews: number[]): boolean {
    const isOff = skews.every((skew) => Math.abs(skew) > TOLERATED && Math.sign(skew) === Math.sign(skews[0] as number));
    return skews.length > 1 && isOff && Math.max(...skews) - Math.min(...skews) <= SPREAD;
}

// One finding per host whose `Date` runs off our clock, an error past an hour; none, and one warning, when every host is off alike.
const clockSkew: Make = (severity) => ({
    meta: { id: "http/clock-skew", severity, scope: "site", facts: ["http.date-skew"], docs: "https://www.rfc-editor.org/rfc/rfc9110#section-6.6.1", fix: "Synchronise the server clock with NTP (chrony or systemd-timesyncd)." },
    check(pages: Facts[]) {
        const measured = pages.filter((page) => page.http["date-skew"] !== undefined);
        const hosts = Map.groupBy(measured, (page) => page.url.host)
            .entries()
            .map(([host, members]) => ({ host, skew: median(members.map((page) => page.http["date-skew"] as number)), urls: members.map((page) => page.url.href) }))
            .toArray();
        const skews = hosts.map((entry) => entry.skew);
        log.debug({ rule: "http/clock-skew", hosts: hosts.length, skews }, "host clocks compared");
        if (isOwnClock(skews)) {
            log.warn({ offset: -(skews[0] as number), hosts: hosts.length }, `the local clock is off by ${-(skews[0] as number)} s; clock skew findings suppressed`);
            return [];
        }
        const findings: Finding[] = [];
        for (const { host, skew, urls } of hosts) {
            if (Math.abs(skew) <= TOLERATED) continue;
            const level = Math.abs(skew) > BROKEN ? "error" : severity;
            findings.push({ rule: "http/clock-skew", severity: level, scope: "site", url: host, ...said(skew > 0 ? "the host’s clock runs ahead of ours" : "the host’s clock runs behind ours"), data: { [host]: { skew: { fact: "http.date-skew", value: Math.abs(skew) } } }, value: skew, urls });
        }
        return findings;
    },
});

export const clockRules: Record<string, Make> = {
    "http/clock-skew": clockSkew,
};
