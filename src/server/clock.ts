// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { fetchRetrying, reason } from "../crawl/fetch.ts";
import { dateSkew } from "../facts/transport.ts";
import { log } from "../logger.ts";
import { isOwnClock } from "../rules/clock.ts";

// Seconds `url`’s `Date` runs ahead of our clock, or undefined when it does not answer or sends none.
async function skewOf(url: string): Promise<number | undefined> {
    try {
        const { value, ms } = await fetchRetrying(url, async (response) => {
            const firstByte = Date.now();
            await response.body?.cancel();
            return { firstByte, headers: Object.fromEntries(response.headers) };
        });
        return dateSkew(url, value.headers, value.firstByte - ms, value.firstByte);
    } catch (error) {
        log.debug({ url, error: reason(error) }, "clock reference unreachable");
        return undefined;
    }
}

// Compares our clock with each reference origin’s `Date` and warns when they all disagree with us alike.
export async function checkClock(references: string[]): Promise<void> {
    if (references.length === 0) return log.debug({ references }, "clock check disabled");
    const answers = await Promise.all(references.map(async (url) => skewOf(url)));
    const skews = answers.filter((skew) => skew !== undefined);
    if (isOwnClock(skews)) log.warn({ offset: -(skews[0] as number), references: skews.length }, "the local clock is off; clock skew findings are unreliable");
    else log.info({ skews, references: references.length }, "local clock checked");
}
