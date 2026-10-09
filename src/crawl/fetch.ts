// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as sleep } from "node:timers/promises";
import { USER_AGENT } from "../agent.ts";
import { log } from "../logger.ts";
import { PrivateAddress } from "./guard.ts";
import { guardedFetch, pace, patient } from "./network.ts";

const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;
const RETRY_STATUS = new Set([429, 503]);

export interface Fetched<T> {
    response: Response;
    value: T;
    ms: number;
}

// Attempts a final answer of `status` cost; 0 is a network failure.
export function attemptsFor(status: number): number {
    return status === 0 || RETRY_STATUS.has(status) ? ATTEMPTS : 1;
}

// Exponential backoff with jitter; a Retry-After in seconds wins, capped at the timeout.
export function delay(attempt: number, retryAfter?: string): number {
    const seconds = Number(retryAfter ?? NaN);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, TIMEOUT_MS) : 500 * 2 ** attempt + Math.random() * 250;
}

// The error undici raises for a short body, a duplicate Content-Length, or one beside chunked.
export const MISMATCH = "Response body length does not match content-length header";

// The innermost cause of a fetch failure, which names the socket error rather than "fetch failed".
export function reason(error: unknown): string {
    return error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
}

// One request with timeout and the spiderlint user agent; network errors, 429 and 503 retry, the last failure or a refused address throws.
export async function fetchRetrying<T>(url: string, consume: (response: Response) => Promise<T>, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Fetched<T>> {
    for (let attempt = 0; ; attempt += 1) {
        const started = performance.now();
        const isLast = attempt === ATTEMPTS - 1;
        try {
            await pace();
            const response = await guardedFetch(url, { method, headers: { ...headers, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(patient(TIMEOUT_MS)) });
            const value = await consume(response);
            log.debug({ url, status: response.status, attempt }, "fetched");
            if (isLast || !RETRY_STATUS.has(response.status)) return { response, value, ms: Math.round(performance.now() - started) };
            await sleep(delay(attempt, response.headers.get("retry-after") ?? undefined));
        } catch (error) {
            log.debug({ url, attempt, error: reason(error) }, "fetch failed");
            if (isLast || error instanceof PrivateAddress) throw error;
            await sleep(delay(attempt));
        }
    }
}
