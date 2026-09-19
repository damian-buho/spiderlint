// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { defaults, type Config } from "./config/index.ts";
import { crawlBrowser } from "./crawl/browser.ts";
import { crawlHttp } from "./crawl/http.ts";
import type { Facts } from "./facts/types.ts";
import { fold } from "./fold/index.ts";
import { assignGroup } from "./groups/assign.ts";
import { log } from "./logger.ts";
import { runRules } from "./rules/run.ts";
import type { Finding } from "./rules/types.ts";
import { MemoryStore } from "./store/memory.ts";

export interface Report {
    pages: Facts[];
    findings: Finding[];
}

// crawl → facts → group → rules → fold; stream mode with an in-memory store.
export async function audit(overrides: Partial<Config>): Promise<Report> {
    const config: Config = { ...defaults(), ...overrides };
    const store = new MemoryStore();
    const crawl = config.fetch === "http" ? crawlHttp : crawlBrowser;
    log.info({ seeds: config.seeds, fetch: config.fetch, maxPages: config.maxPages }, "audit start");
    await crawl(config, (facts) => {
        facts.group = assignGroup(facts);
        store.add(facts);
    });
    const findings = fold(runRules(store.pages, []));
    log.info({ pages: store.pages.length, findings: findings.length }, "audit done");
    return { pages: store.pages, findings };
}
