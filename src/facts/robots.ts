// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from "../logger.ts";
import type { Facts, RobotsFacts } from "./types.ts";

// `none` is noindex plus nofollow; a bot-scoped `X-Robots-Tag` directive counts as well.
export function robotsFacts(page: Facts): RobotsFacts {
    const header = page.http.headers["x-robots-tag"] ?? [];
    const directives = [page.html?.meta.robots ?? "", header].flat().join(",").toLowerCase();
    const robots = { noindex: /\b(noindex|none)\b/.test(directives), nofollow: /\b(nofollow|none)\b/.test(directives) };
    if (robots.noindex || robots.nofollow) log.debug({ url: page.url.href, directives, ...robots }, "indexing restricted");
    return robots;
}
