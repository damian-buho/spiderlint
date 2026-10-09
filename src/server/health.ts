// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { DEFAULT_PATH, readSettings } from "./settings.ts";

// Exits 0 when the API answers /healthz on the address the settings name, 1 otherwise.
const { listen } = readSettings(process.env.SPIDERLINT_SERVER_CONFIG ?? DEFAULT_PATH);
const host = ["0.0.0.0", "::"].includes(listen.host) ? "127.0.0.1" : listen.host;
try {
    const response = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${listen.port}/healthz`, { signal: AbortSignal.timeout(2000) });
    process.exitCode = response.ok ? 0 : 1;
} catch {
    process.exitCode = 1;
}
