// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { CheerioCrawler, Configuration } from "crawlee";
import type { Readable } from "node:stream";
import { USER_AGENT } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { capped, isParsed, replayed, type Capped } from "./body.ts";
import { extractHtml, HTML_TYPES } from "../facts/html.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, earlyHintsHook, redactHeaders, timingFacts, tlsFacts, type Transport } from "../facts/transport.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { Frontier, type CrawlCache, type CrawlResult, type CrawlStorage, type Earlier, type OnPage } from "./frontier.ts";
import { bridgeCrawleeLog } from "./log.ts";
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
    return first(facts.http.headers["content-type"]) ?? `${facts.http.contentType}${facts.http.charset ? `; charset=${facts.http.charset}` : ""}`;
}

// Wire bytes received so far, from got's progress on the original response stream.
function transferred(source: unknown): number | undefined {
    return (source as { downloadProgress?: { transferred?: number } }).downloadProgress?.transferred;
}

// The response's own connection, read while it is still attached.
function socketOf(source: unknown): Transport["socket"] {
    const stream = source as { socket?: Transport["socket"]; request?: { socket?: Transport["socket"] } };
    return stream.socket ?? stream.request?.socket;
}

// Fetches seeds, follows in-scope links through the frontier; storage stays in memory.
export async function crawlHttp(config: Config, onPage: OnPage, cache: CrawlCache, storage?: CrawlStorage, proxy?: string): Promise<CrawlResult> {
    bridgeCrawleeLog();
    const frontier = await Frontier.open(config, cache);
    const revalidating = new WeakMap<object, Earlier>();
    const hinted = new WeakMap<object, NonNullable<Facts["http"]["earlyHints"]>>();
    let revalidatedPages = 0;
    const bodies = new WeakMap<object, Capped & { source: Transport; tls?: ReturnType<typeof tlsFacts>; remote?: { address: string; family?: string } }>();
    const crawler = new CheerioCrawler(
        {
            additionalMimeTypes: ["*/*"],
            ...frontier.options(storage, proxy),
            maxConcurrency: width(config.concurrency),
            preNavigationHooks: [
                async ({ request }, gotOptions) => {
                    Object.assign(gotOptions, { headers: { ...gotOptions.headers, "user-agent": USER_AGENT } });
                    const hints: NonNullable<Facts["http"]["earlyHints"]> = [];
                    hinted.set(request, hints);
                    Object.assign(gotOptions, { hooks: { ...gotOptions.hooks, beforeRequest: [...(gotOptions.hooks?.beforeRequest ?? []), earlyHintsHook(request.url, hints)] } });
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
                const earlier = response.statusCode === 304 ? revalidating.get(request) : undefined;
                const isHtml = HTML_TYPES.has(contentType.type);
                const cap = bodies.get(request);
                const decoded = Buffer.byteLength(body);
                const declared = Number(response.headers["content-length"]);
                const facts: Facts = {
                    ...frontier.identity(request, url),
                    http: {
                        status: response.statusCode ?? 0,
                        ...(cap?.source.httpVersion && { version: cap.source.httpVersion }),
                        redirects: (cap?.source.redirectUrls ?? []).map((redirect) => ({ url: String(redirect) })),
                        headers: redactHeaders(response.headers),
                        ...(cap?.remote && { remote: cap.remote }),
                        timing: cap ? timingFacts(cap.source) : {},
                        cookies: cookieFacts(response.headers["set-cookie"]),
                        ...(hinted.get(request)?.length && { earlyHints: hinted.get(request) }),
                        size: {
                            body: transferred(cap?.source) ?? decoded,
                            decoded,
                            ...(Number.isSafeInteger(declared) && { declared }),
                            ...(cap?.isTruncated() && { truncated: true as const }),
                        },
                        contentType: contentType.type,
                        ...(contentType.encoding && { charset: contentType.encoding }),
                    },
                    ...(cap?.tls && { tls: cap.tls }),
                    ...(isHtml && { html: extractHtml($, body.toString(), url, config.scope), resources: extractResources($, url, config.maxResourcesPerPage) }),
                };
                if (earlier) facts.http = revalidated(earlier.facts, facts);
                revalidatedPages += earlier ? 1 : 0;
                log.debug({ url: url.href, status: facts.http.status, type: facts.http.contentType, bytes: facts.http.size.body, depth: facts.crawl.depth, revalidated: facts.http.revalidated }, "page fetched");
                await onPage(facts, body.toString());
                if (!isHtml) return;
                log.debug({ url: url.href, enqueued: await frontier.enqueue(enqueueLinks, facts) }, "links enqueued");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false }),
    );
    await frontier.run(crawler, cache.robots);
    if (revalidatedPages > 0) log.info({ revalidated: revalidatedPages }, "pages revalidated");
    return { site: frontier.site(), launches: 0 };
}
