// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { MIMEType } from "node:util";
import { Configuration, PlaywrightCrawler, type PlaywrightCrawlerOptions, type PlaywrightCrawlingContext, type PlaywrightDirectNavigationOptions, type Request as CrawleeRequest } from "crawlee";
import type { Page, Request, Response } from "playwright";
import { USER_AGENT } from "../agent.ts";
import type { Config } from "../config/index.ts";
import { headerFacts, observedResources, redirectFacts, remoteFacts, timingFacts, tlsFacts, weightFacts } from "../facts/browser.ts";
import { extractHtml, HTML_TYPES } from "../facts/html.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, redactHeaders } from "../facts/transport.ts";
import type { BrowserFacts, Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { isParsed } from "./body.ts";
import { Frontier, type CrawlCache, type CrawlStorage, type OnPage } from "./frontier.ts";
import { bridgeCrawleeLog } from "./log.ts";
import { STRATEGY } from "./scope.ts";

const NAVIGATION_TIMEOUT_SECS = 30;
const SETTLE_MS = 5000;

type Transport = Pick<Facts, "tls"> & { headers: Record<string, string | string[]>; remote?: Facts["http"]["remote"] };

// What one page load showed besides its DOM: the document response, console output, every sub-request.
interface Observation {
    document?: Response;
    transport?: Promise<Transport>;
    isDownload?: true;
    console: BrowserFacts["console"];
    requests: Request[];
}

// Headers, address and certificate of a document response; an unreadable one keeps no headers rather than failing the page.
async function readTransport(response: Response): Promise<Transport> {
    try {
        const [headers, address, security] = await Promise.all([response.headersArray(), response.serverAddr(), response.securityDetails()]);
        const tls = tlsFacts(security);
        return { headers: headerFacts(headers), remote: remoteFacts(address), ...(tls && { tls }) };
    } catch (error) {
        log.warn({ url: response.url(), error: String(error) }, "document transport unreadable");
        return { headers: {} };
    }
}

// Listens to a page before it navigates, so a download that aborts the navigation still leaves its response behind.
function observe(page: Page): Observation {
    const seen: Observation = { console: { errors: [], warnings: [] }, requests: [] };
    const errors = new Set<string>();
    const warnings = new Set<string>();
    page.on("response", (response) => {
        if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
        seen.document = response;
        seen.transport = readTransport(response);
    });
    page.on("console", (message) => {
        const bucket = message.type() === "error" ? errors : message.type() === "warning" ? warnings : undefined;
        bucket?.add(message.text());
        seen.console = { errors: [...errors], warnings: [...warnings] };
    });
    page.on("pageerror", (error) => {
        errors.add(error.message);
        seen.console = { errors: [...errors], warnings: [...warnings] };
    });
    const record = (request: Request) => {
        seen.requests.push(request);
    };
    page.on("requestfinished", record);
    page.on("requestfailed", record);
    return seen;
}

// `type/subtype` and charset of a Content-Type header; an unparsable one is its raw essence.
function contentTypeOf(header: string | string[] | undefined): { type: string; charset?: string } {
    const raw = [header ?? ""].flat()[0] ?? "";
    try {
        const mime = new MIMEType(raw);
        const charset = mime.params.get("charset");
        return { type: mime.essence, ...(charset && { charset }) };
    } catch {
        return { type: raw.split(";", 1)[0]?.trim().toLowerCase() ?? "" };
    }
}

// Http and tls facts of a document response; `size` is what the caller could measure of its body.
async function transportFacts(observation: Observation, size: Facts["http"]["size"], timing: Facts["http"]["timing"]): Promise<Pick<Facts, "http" | "tls">> {
    const response = observation.document as Response;
    const { headers, remote, tls } = await (observation.transport as Promise<Transport>);
    const { type, charset } = contentTypeOf(headers["content-type"]);
    return {
        http: {
            status: response.status(),
            redirects: redirectFacts(response.request()),
            headers: redactHeaders(headers),
            ...(remote && { remote }),
            timing,
            cookies: cookieFacts(headers["set-cookie"]),
            size,
            contentType: type,
            ...(charset && { charset }),
        },
        ...(tls && { tls }),
    };
}

// The byte count a Content-Length header declares, when it is a whole number.
function declaredSize(headers: Record<string, string | string[]>): { declared?: number } {
    const declared = Number(headers["content-length"]);
    return Number.isSafeInteger(declared) ? { declared } : {};
}

// A milestone the page reached, in whole milliseconds; zero means it never fired.
function reached(value: number | undefined): number | undefined {
    return value && value > 0 ? Math.round(value) : undefined;
}

// Navigation Timing milestones, measured from the start of the navigation.
async function milestones(page: Page): Promise<BrowserFacts["timing"]> {
    const entry = await page.evaluate(() => performance.getEntriesByType("navigation")[0]?.toJSON() as { domContentLoadedEventEnd?: number; loadEventEnd?: number } | undefined);
    const domContentLoaded = reached(entry?.domContentLoadedEventEnd);
    const load = reached(entry?.loadEventEnd);
    return { ...(domContentLoaded !== undefined && { domContentLoaded }), ...(load !== undefined && { load }) };
}

// Waits for the network to go quiet so client-rendered tags land; a page that never settles is read as it stands.
async function didSettle(page: Page): Promise<boolean> {
    try {
        await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
        return true;
    } catch {
        return false;
    }
}

// A navigation Chromium turned into a download.
function isDownload(error: unknown): boolean {
    return error instanceof Error && /Download is starting|net::ERR_ABORTED/.test(error.message);
}

// Chromium aborts a navigation that becomes a download; the response it already had stands in as the page.
class Crawler extends PlaywrightCrawler {
    readonly #observations: WeakMap<CrawleeRequest, Observation>;

    constructor(options: PlaywrightCrawlerOptions, config: Configuration, observations: WeakMap<CrawleeRequest, Observation>) {
        super(options, config);
        this.#observations = observations;
    }

    protected override async _navigationHandler(context: PlaywrightCrawlingContext, gotoOptions: PlaywrightDirectNavigationOptions): Promise<Response | null> {
        try {
            return await super._navigationHandler(context, gotoOptions);
        } catch (error) {
            const observation = this.#observations.get(context.request);
            if (!isDownload(error) || !observation?.document) throw error;
            log.debug({ url: context.request.url, status: observation.document.status() }, "navigation became a download");
            observation.isDownload = true;
            return observation.document;
        }
    }
}

// The body as the facts see it: rendered DOM for HTML, raw text for other parsed types, nothing for a download or a binary.
async function bodyOf(page: Page, response: Response, observation: Observation, type: string): Promise<{ raw: Buffer; text: string }> {
    if (observation.isDownload) return { raw: Buffer.alloc(0), text: "" };
    const raw = await response.body();
    return { raw, text: HTML_TYPES.has(type) ? await page.content() : isParsed(type) ? raw.toString("utf8") : "" };
}

// Renders every page in Chromium; facts come from the rendered DOM and the browser’s own network log.
export async function crawlBrowser(config: Config, onPage: OnPage, cache: CrawlCache, storage?: CrawlStorage): Promise<SiteFacts> {
    bridgeCrawleeLog();
    const frontier = await Frontier.open(config, cache);
    const observations = new WeakMap<CrawleeRequest, Observation>();
    const crawler = new Crawler(
        {
            ...frontier.options(storage),
            headless: true,
            navigationTimeoutSecs: NAVIGATION_TIMEOUT_SECS,
            launchContext: { userAgent: USER_AGENT },
            browserPoolOptions: { useFingerprints: false },
            preNavigationHooks: [
                ({ page, request }) => {
                    observations.set(request, observe(page));
                },
            ],
            async requestHandler({ request, page, parseWithCheerio, enqueueLinks }) {
                const observation = observations.get(request);
                const response = observation?.document;
                if (!observation || !response) return log.warn({ url: request.url }, "page rendered without a document response");
                const url = new URL(response.url());
                if (!frontier.admit(request, url)) return;
                const { headers } = await (observation.transport as Promise<Transport>);
                const { type } = contentTypeOf(headers["content-type"]);
                const isHtml = HTML_TYPES.has(type) && !observation.isDownload;
                const settled = isHtml && (await didSettle(page));
                const { raw, text } = await bodyOf(page, response, observation, type);
                const body = text.slice(0, config.maxBodySize);
                const sizes = observation.isDownload ? undefined : await response.request().sizes();
                const wire = sizes?.responseBodySize ?? 0;
                const size = { body: wire, decoded: raw.length, ...declaredSize(headers), ...((body.length < text.length || observation.isDownload) && { truncated: true as const }) };
                const timing = observation.isDownload ? {} : timingFacts(response.request().timing());
                const facts: Facts = { ...frontier.identity(request, url), ...(await transportFacts(observation, size, timing)) };
                if (isHtml) {
                    const $ = await parseWithCheerio();
                    facts.html = extractHtml($, url, config.scope);
                    facts.resources = observedResources(extractResources($, url, config.maxResourcesPerPage), observation.requests, url, config.maxResourcesPerPage);
                    facts.browser = { timing: await milestones(page), console: observation.console, weight: await weightFacts(observation.requests) };
                }
                log.debug({ url: url.href, status: facts.http.status, type, bytes: size.body, depth: facts.crawl.depth, settled, isDownload: observation.isDownload === true, requests: observation.requests.length }, "page rendered");
                await onPage(facts, body);
                if (!isHtml) return;
                const { processedRequests } = await enqueueLinks({ strategy: STRATEGY[config.scope], transformRequestFunction: frontier.transformRequestFunction });
                log.debug({ url: url.href, enqueued: processedRequests.filter((entry) => !entry.wasAlreadyPresent).length }, "links enqueued");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false }),
        observations,
    );
    if (storage?.earlier) log.info({ fetch: "browser" }, "browser pages are re-rendered, never revalidated");
    await frontier.run(crawler, cache.robots);
    return { sitemaps: frontier.files };
}
