// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { constants } from "node:os";
import { log } from "./logger.ts";

const controller = new AbortController();
// Aborted with the signal name by the first SIGINT or SIGTERM.
export const interrupted: AbortSignal = controller.signal;

// A run a signal stopped between two stages.
export class Interrupted extends Error {
    readonly code: number;

    constructor(signal: NodeJS.Signals, stage: string) {
        super(`interrupted by ${signal} before ${stage}`);
        this.code = 128 + constants.signals[signal];
    }
}

// Throws Interrupted once a signal arrived, so `stage` never starts.
export function stopIfInterrupted(stage: string): void {
    log.debug({ stage, signal: interrupted.reason as unknown }, "interrupt checked");
    if (interrupted.aborted) throw new Interrupted(interrupted.reason as NodeJS.Signals, stage);
}

// A first signal stops the run at its next stage; a second exits at once, proper-lockfile’s exit hook releasing the store.
export function handleInterrupts(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            const code = 128 + constants.signals[signal];
            if (interrupted.aborted) {
                log.warn({ signal, code }, "interrupted again, exiting now");
                // eslint-disable-next-line n/no-process-exit -- a second signal means now, and signal-exit releases the lock on exit
                process.exit(code);
            }
            log.warn({ signal }, "interrupted, stopping after the pages in flight; press Ctrl-C again to exit now");
            controller.abort(signal);
        });
    }
}
