// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { Configuration } from "crawlee";
import { userStateDirectory } from "../cache/index.ts";
import { log } from "../logger.ts";

// Crawlee’s global storage is scratch: held in memory, rooted in the XDG state directory should it spill.
export function useScratchStorage(): void {
    const directory = path.join(userStateDirectory(), "crawlee");
    const global = Configuration.getGlobalConfig();
    global.set("persistStorage", false);
    global.set("storageClientOptions", { localDataDirectory: directory });
    log.debug({ directory }, "crawlee scratch storage set");
}
