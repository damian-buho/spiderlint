// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Rule, Severity } from "./types.ts";

type Make = (severity: Exclude<Severity, "off">) => Rule;

// Every in-scope page answering 4xx or 5xx, with the pages that link to it.
const brokenInternal: Make = (severity) => ({
    meta: { id: "links/broken-internal", severity, scope: "site", facts: ["http.status", "crawl.referrers"] },
    check(pages: Facts[]) {
        const findings: Finding[] = [];
        for (const page of pages) {
            if (page.http.status < 400) continue;
            log.debug({ url: page.url.href, status: page.http.status, referrers: page.crawl.referrers.length }, "broken link");
            findings.push({ rule: "links/broken-internal", severity, scope: "site", url: page.url.href, message: `http.status is ${page.http.status}; linked from ${page.crawl.referrers.length} pages`, value: page.http.status, urls: page.crawl.referrers });
        }
        return findings;
    },
});

// TypeScript rules a preset enables by ID alone.
export const builtin: Record<string, Make> = { "links/broken-internal": brokenInternal };
