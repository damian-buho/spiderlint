// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Config } from "../config/index.ts";
import type { SiteFacts } from "../facts/types.ts";
import type { CrawlCache, CrawlStorage, OnPage } from "./http.ts";

// Playwright adapter lands with the browser.* extractors.
export function crawlBrowser(config: Config, _onPage: OnPage, _cache: CrawlCache, _storage?: CrawlStorage): Promise<SiteFacts> {
    return Promise.reject(new Error(`fetch mode ${config.fetch} is not implemented yet`));
}
