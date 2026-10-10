// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { CheerioCrawler, Configuration, type CheerioCrawlingContext } from "crawlee";
import type { Readable } from "node:stream";
import { userAgent } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { ACCEPT_ENCODING, capped, isParsed, replayed, type Capped } from "./body.ts";
import { extractHtml, HTML_TYPES } from "../facts/html.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, dateSkew, earlyHintsHook, redactHeaders, redirectHook, timingFacts, tlsFacts, type Transport } from "../facts/transport.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { CrawlStorage, Earlier, Frontier, OnPage } from "./frontier.ts";
import { MISMATCH, reason } from "./fetch.ts";
import { guardUrl } from "./network.ts";
import { width } from "./resources.ts";

// The first value of a header that may repeat.
function first(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

// `If-None-Match` and `If-Modified-Since` from a stored page’s `ETag` and `Last-Modified`.
function validators(headers: Facts["http"]["headers"]): Record<string, string> {
    const etag = first(headers.etag);
    const modified = first(headers["last-modified"]);
    return { ...(etag && { "if-none-match": etag }), ...(modified && { "if-modified-since": modified }) };
}

// A 304 keeps the stored status, size and cookies and merges its headers over the stored ones.
function revalidated(earlier: Facts, fresh: Facts): Facts["http"] {
    const cookies = fresh.http.cookies.length > 0 ? fresh.http.cookies : earlier.http.cookies;
    const headers = { ...earlier.http.headers, ...fresh.http.headers };
    return { ...fresh.http, status: earlier.http.status, size: earlier.http.size, headers, cookies, revalidated: true };
}

// The stored `Content-Type` header, else one rebuilt from the stored type and charset.
function storedContentType(facts: Facts): string {
    return first(facts.http.headers["content-type"]) ?? `${facts.http["content-type"]}${facts.http.charset ? `; charset=${facts.http.charset}` : ""}`;
}

// Wire bytes received so far, from got's progress on the original response stream.
function transferred(source: unknown): number | undefined {
    return (source as { downloadProgress?: { transferred?: number } } | undefined)?.downloadProgress?.transferred;
}

// The response's own connection, read while it is still attached.
function socketOf(source: unknown): Transport["socket"] {
    const stream = source as { socket?: Transport["socket"]; request?: { socket?: Transport["socket"] } };
    return stream.socket ?? stream.request?.socket;
}

// Why a page fetch failed, naming both byte counts when the body ended short of `Content-Length`.
function failure(error: Error, source: (Transport & { headers?: Record<string, string | string[] | undefined> }) | undefined): string {
    const declared = Number(first(source?.headers?.["content-length"]));
    const received = transferred(source);
    log.debug({ error: error.message, declared, received }, "page failure named");
    if (received !== undefined && received < declared) return `${MISMATCH}: body ended at ${received} of the ${declared} bytes Content-Length declares`;
    return /content-length/i.test(error.message) ? MISMATCH : reason(error);
}

// Hands a request its group renders to the browser before fetching it.
class Crawler extends CheerioCrawler {
    readonly #frontier: Frontier;

    constructor(options: ConstructorParameters<typeof CheerioCrawler>[0], config: Configuration, frontier: Frontier) {
        super(options, config);
        this.#frontier = frontier;
    }

    protected override async _runRequestHandler(context: CheerioCrawlingContext): Promise<void> {
        const isHanded = await this.#frontier.handOff(context.request);
        log.debug({ url: context.request.url, isHanded }, "request crawler chosen");
        return isHanded ? undefined : super._runRequestHandler(context);
    }
}

// The http crawler of a frontier: fetches and parses without rendering; storage stays in memory.
export function httpCrawler(config: Config, onPage: OnPage, frontier: Frontier, storage?: CrawlStorage, proxy?: string): { crawler: CheerioCrawler; stats(): { pages: number; revalidated: number } } {
    let pages = 0;
    const revalidating = new WeakMap<object, Earlier>();
    const hinted = new WeakMap<object, NonNullable<Facts["http"]["early-hints"]>>();
    const hopped = new WeakMap<object, Facts["http"]["redirects"]>();
    let revalidatedPages = 0;
    const bodies = new WeakMap<object, Capped & { source: Transport; tls?: ReturnType<typeof tlsFacts>; remote?: { address: string; family?: string } }>();
    const crawler = new Crawler(
        {
            additionalMimeTypes: ["*/*"],
            ...frontier.options("http", storage, proxy),
            maxConcurrency: width(config.concurrency),
            preNavigationHooks: [
                async ({ request }, gotOptions) => {
                    bodies.delete(request);
                    Object.assign(gotOptions, { decompress: false, headers: { ...gotOptions.headers, "user-agent": userAgent(), "accept-encoding": ACCEPT_ENCODING } });
                    const hints: NonNullable<Facts["http"]["early-hints"]> = [];
                    hinted.set(request, hints);
                    const hops: Facts["http"]["redirects"] = [];
                    hopped.set(request, hops);
                    Object.assign(gotOptions, {
                        hooks: { ...gotOptions.hooks, beforeRequest: [...(gotOptions.hooks?.beforeRequest ?? []), (options: { url?: URL | string }) => guardUrl(options.url ?? request.url), earlyHintsHook(request.url, hints)], beforeRedirect: [...(gotOptions.hooks?.beforeRedirect ?? []), redirectHook(hops)] },
                    });
                    const earlier = config.cacheMode === "use" ? await storage?.earlier?.(request.url) : undefined;
                    const conditional = earlier ? validators(earlier.facts.http.headers) : {};
                    log.debug({ url: request.url, isStored: earlier !== undefined, conditional: Object.keys(conditional) }, "page revalidation decided");
                    if (earlier && Object.keys(conditional).length > 0) {
                        revalidating.set(request, earlier);
                        Object.assign(gotOptions, { headers: { ...gotOptions.headers, ...conditional } });
                    }
                    if (config.keepalive) return;
                    Object.assign(gotOptions, { http2: false, headers: { ...gotOptions.headers, connection: "close" } });
                },
            ],
            postNavigationHooks: [
                (context) => {
                    const source = context.response as unknown as Readable & { headers: Record<string, string | undefined> };
                    const contentType = source.headers["content-type"];
                    const max = isParsed(contentType) ? config.maxBodySize : 0;
                    const cap = capped(source, max);
                    log.debug({ url: context.request.url, contentType, max }, "body capped");
                    const socket = socketOf(source);
                    const address = socket?.remoteAddress ?? (source as Transport).ip;
                    const remote = address ? { address, ...(socket?.remoteFamily && { family: socket.remoteFamily }) } : undefined;
                    bodies.set(context.request, { ...cap, source: source as Transport, tls: tlsFacts(socket), remote });
                    const earlier = (source as unknown as { statusCode?: number }).statusCode === 304 ? revalidating.get(context.request) : undefined;
                    log.debug({ url: context.request.url, isReplayed: earlier !== undefined }, "page body chosen");
                    Object.assign(context, { response: earlier ? replayed(cap.stream, earlier.body, storedContentType(earlier.facts)) : cap.stream });
                },
            ],
            async requestHandler({ request, response, body, $, contentType, enqueueLinks }) {
                const url = new URL(request.loadedUrl ?? request.url);
                if (!frontier.admit(request, url)) return;
                const pending = revalidating.get(request);
                const earlier = response.statusCode === 304 ? pending : undefined;
                // A validator answered 200 with the stored body still byte-identical.
                const isUnmodified = response.statusCode === 200 && pending !== undefined && body.toString() === pending.body;
                const isHtml = HTML_TYPES.has(contentType.type);
                const cap = bodies.get(request);
                const decoded = Buffer.byteLength(body);
                const declared = Number(response.headers["content-length"]);
                const skew = dateSkew(url.href, response.headers, cap?.source.timings?.upload, cap?.source.timings?.response);
                const facts: Facts = {
                    ...frontier.identity(request, url, "http"),
                    http: {
                        status: response.statusCode ?? 0,
                        ...(cap?.source.httpVersion && { version: cap.source.httpVersion }),
                        redirects: (cap?.source.redirectUrls ?? []).map((redirect, index, all) => hopped.get(request)?.at(index - all.length) ?? { url: String(redirect) }),
                        headers: redactHeaders(response.headers),
                        ...(cap?.remote && { remote: cap.remote }),
                        timing: cap ? timingFacts(cap.source) : {},
                        cookies: cookieFacts(response.headers["set-cookie"], response.headers.date),
                        ...(hinted.get(request)?.length && { "early-hints": hinted.get(request) }),
                        size: {
                            body: transferred(cap?.source) ?? decoded,
                            decoded,
                            ...(Number.isSafeInteger(declared) && { declared }),
                            ...(cap?.isTruncated() && { truncated: true as const }),
                        },
                        "content-type": contentType.type,
                        ...(contentType.encoding && { charset: contentType.encoding }),
                        ...(skew !== undefined && { "date-skew": skew }),
                        ...(isUnmodified && { unmodified: true as const }),
                    },
                    ...(cap?.tls && { tls: cap.tls }),
                    ...(isHtml && { html: extractHtml($, body.toString(), url, config.scope), resources: extractResources($, url, config.maxResourcesPerPage) }),
                };
                if (earlier) facts.http = revalidated(earlier.facts, facts);
                revalidatedPages += earlier ? 1 : 0;
                pages += 1;
                log.debug({ url: url.href, status: facts.http.status, type: facts.http["content-type"], bytes: facts.http.size.body, depth: facts.crawl.depth, revalidated: facts.http.revalidated, unmodified: facts.http.unmodified }, "page fetched");
                await onPage(facts, body.toString());
                if (!isHtml && !facts.feed) return;
                log.debug({ url: url.href, enqueued: await frontier.enqueue(enqueueLinks, facts, "http") }, "links enqueued");
            },
            async failedRequestHandler({ request }, error) {
                const facts = frontier.failed(request, failure(error, bodies.get(request)?.source));
                if (facts) await onPage(facts, "");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false, purgeOnStart: false }),
        frontier,
    );
    return { crawler, stats: () => ({ pages, revalidated: revalidatedPages }) };
}
