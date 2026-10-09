// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { serveFixture } from "./server.ts";

// Standalone entry: `node --experimental-strip-types tests/fixtures/serve.ts` prints the origin and blocks.
const site = await serveFixture();
console.log(site.origin);
