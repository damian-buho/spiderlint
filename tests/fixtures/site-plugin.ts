// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { setTimeout as sleep } from "node:timers/promises";
import { definePlugin } from "../../src/plugins/types.ts";

// Real runs of each extractor, read by the tests.
export const runs = { robots: 0, stuck: 0 };

// Probes each host’s robots.txt once, and never finishes a second probe inside its timeout.
export default definePlugin({
    name: "fixture-hosts",
    sites: [
        {
            id: "robots",
            per: "host",
            async extract(_host, context) {
                runs.robots += 1;
                const answer = await context.fetch(`${context.pages[0]?.url.origin}/robots.txt`);
                return { status: answer.status, pages: context.pages.length };
            },
        },
        {
            id: "stuck",
            per: "host",
            timeout: 50,
            async extract(_host, context) {
                runs.stuck += 1;
                await sleep(10_000, undefined, { signal: context.signal });
                return { done: true };
            },
        },
    ],
    presets: {
        hosts: {
            rules: {
                "hosts/robots-gone": { fact: "site.hosts.*.robots.status", expect: { const: 404 }, message: "robots.txt answers {got}" },
                "hosts/stuck": { fact: "site.hosts.*.stuck.done", expect: { const: true } },
            },
        },
    },
});
