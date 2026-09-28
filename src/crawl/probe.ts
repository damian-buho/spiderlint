// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { USER_AGENT } from "../agent.ts";
import { redactHeaders } from "../facts/transport.ts";
import { log } from "../logger.ts";
import { delay, reason } from "./fetch.ts";
import { guardedLookup, isPrivate, PrivateAddress } from "./guard.ts";
import { pace, patient } from "./network.ts";
import { robotsFactsOf, type RobotsFor } from "./robots.ts";

const ATTEMPTS = 2;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 10;
const MAX_BODY = 1_048_576;
const RETRY_STATUS = new Set([429, 503]);

export interface ProbeInit {
    method?: "GET" | "HEAD";
    headers?: Record<string, string>;
    // `follow` walks redirects while they stay on the probed host; `manual` answers the first response.
    redirect?: "follow" | "manual";
    // Keeps the raw body as `bytes`, for an image the text body would mangle.
    binary?: true;
}

export interface Probe {
    url: string;
    status: number;
    headers: Record<string, string | string[]>;
    body: string;
    redirects: { url: string; status: number }[];
    truncated?: true;
    bytes?: Buffer;
    ms: number;
}

export interface ProbeOptions {
    // The host every probed URL and redirect hop must stay on.
    host: string;
    allowPrivate: boolean;
    signal: AbortSignal;
    // The run’s robots.txt verdicts; unset when `robots` is off.
    robots?: RobotsFor;
}

// A probe robots.txt disallows for `spiderlint`, never sent; `unreachable` when that is only because the file did not answer.
export class RobotsDisallowed extends Error {
    readonly unreachable?: string;

    constructor(message: string, unreachable?: string) {
        super(message);
        if (unreachable !== undefined) this.unreachable = unreachable;
    }
}

// Reads at most MAX_BODY bytes of a response, as text and as they came.
async function text(response: IncomingMessage): Promise<{ body: string; raw: Buffer; truncated?: true }> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response as AsyncIterable<Buffer>) {
        chunks.push(chunk);
        bytes += chunk.byteLength;
        if (bytes < MAX_BODY) continue;
        response.destroy();
        const raw = Buffer.concat(chunks).subarray(0, MAX_BODY);
        return { body: raw.toString("utf8"), raw, truncated: true };
    }
    const raw = Buffer.concat(chunks);
    return { body: raw.toString("utf8"), raw };
}

// One request on a guarded socket, never following a redirect.
async function once(url: URL, init: ProbeInit, options: ProbeOptions): Promise<Omit<Probe, "redirects" | "ms">> {
    const literal = url.hostname.replaceAll(/^\[|\]$/g, "");
    if (!options.allowPrivate && isIP(literal) && isPrivate(literal)) throw new PrivateAddress(`${url.hostname} is a private address`);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    await pace();
    const expiry = AbortSignal.timeout(patient(TIMEOUT_MS));
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = request(url, { method: init.method ?? "GET", headers: { ...init.headers, "user-agent": USER_AGENT }, signal: AbortSignal.any([options.signal, expiry]), ...(!options.allowPrivate && { lookup: guardedLookup }) }, resolve);
        outgoing.on("error", reject);
        outgoing.end();
    });
    const { body, raw, truncated } = await text(response);
    return { url: url.href, status: response.statusCode ?? 0, headers: redactHeaders(response.headers as Record<string, string | string[]>), body, ...(truncated && { truncated }), ...(init.binary && { bytes: raw }) };
}

// One request with a retry on a network error, 429 or 503.
async function retrying(url: URL, init: ProbeInit, options: ProbeOptions): Promise<Omit<Probe, "redirects" | "ms">> {
    for (let attempt = 0; ; attempt += 1) {
        const isLast = attempt === ATTEMPTS - 1;
        try {
            const answer = await once(url, init, options);
            log.debug({ url: url.href, method: init.method ?? "GET", status: answer.status, attempt }, "probed");
            if (isLast || !RETRY_STATUS.has(answer.status)) return answer;
            const retryAfter = answer.headers["retry-after"];
            await sleep(delay(attempt, typeof retryAfter === "string" ? retryAfter : undefined), undefined, { signal: options.signal });
        } catch (error) {
            log.debug({ url: url.href, attempt, error: reason(error) }, "probe failed");
            if (isLast || error instanceof PrivateAddress || options.signal.aborted) throw error;
            await sleep(delay(attempt), undefined, { signal: options.signal });
        }
    }
}

// A GET or HEAD on `options.host` only, through the address guard unless private addresses are allowed.
export async function probe(href: string, init: ProbeInit, options: ProbeOptions): Promise<Probe> {
    const started = performance.now();
    const redirects: Probe["redirects"] = [];
    let url = new URL(href);
    for (let hop = 0; ; hop += 1) {
        if (url.hostname !== options.host) throw new Error(`probe ${url.href} leaves host ${options.host}`);
        const robots = await options.robots?.(url.href);
        if (robots && !robots.isAllowed(url.href, "spiderlint")) {
            const facts = robotsFactsOf(robots);
            const unreachable = facts?.error ?? (facts && facts.status >= 500 ? `robots.txt answers ${facts.status}` : undefined);
            log.info({ url: url.href, unreachable }, "robots.txt disallows the probe; skipped");
            throw new RobotsDisallowed(`robots.txt disallows ${url.href}`, unreachable);
        }
        const answer = await retrying(url, init, options);
        const location = answer.headers.location;
        const isRedirect = answer.status >= 300 && answer.status < 400 && typeof location === "string";
        const next = isRedirect && URL.canParse(location, url) ? new URL(location, url) : undefined;
        const isFollowed = init.redirect === "follow" && next?.hostname === options.host && hop < MAX_HOPS;
        log.debug({ url: url.href, status: answer.status, location, hop, isFollowed }, "probe answered");
        if (!isFollowed) return { ...answer, redirects, ms: Math.round(performance.now() - started) };
        redirects.push({ url: url.href, status: answer.status });
        url = next as URL;
    }
}
