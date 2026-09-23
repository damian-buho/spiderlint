// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";

export const VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// How every request names the tool (AGENTS.md ## Security).
export const USER_AGENT = `spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`;
