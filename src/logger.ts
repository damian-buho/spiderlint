// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import pino from "pino";

const level = process.env.SPIDERLINT_LOG_LEVEL ?? "info";

// JSON to stderr so stdout stays the report; pretty only on a terminal.
export const log = pino(
    process.stderr.isTTY
        ? { level, transport: { target: "pino-pretty", options: { destination: 2, ignore: "pid,hostname" } } }
        : { level },
    process.stderr.isTTY ? undefined : pino.destination(2),
);
