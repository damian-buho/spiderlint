#!/usr/bin/env node

// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";

// A package carries its build in dist/; a checkout runs the sources.
const built = new URL("../dist/cli.js", import.meta.url);
await import(existsSync(built) ? built.href : new URL("../src/cli.ts", import.meta.url).href);
