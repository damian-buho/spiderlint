// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { load } from "cheerio";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { MIMEType } from "node:util";
import { Configuration, PlaywrightCrawler, type PlaywrightCrawlerOptions, type PlaywrightCrawlingContext, type PlaywrightDirectNavigationOptions, type Request as CrawleeRequest } from "crawlee";
import { chromium, firefox, webkit, type BrowserType, type Page, type Request, type Response } from "playwright";
import { USER_AGENT } from "../agent.ts";
import { ConfigError, type BrowserName, type Config } from "../config/index.ts";
import { COOKIE_WRITES, headerFacts, observedResources, scriptCookies, redirectFacts, remoteFacts, timingFacts, tlsFacts, weightFacts, wireSize, withProbe } from "../facts/browser.ts";
import { extractHtml, HTML_TYPES } from "../facts/html.ts";
import { parityFacts } from "../facts/parity.ts";
import { extractResources } from "../facts/resources.ts";
import { cookieFacts, dateSkew, redactHeaders } from "../facts/transport.ts";
import type { BrowserFacts, Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { isParsed } from "./body.ts";
import { reason } from "./fetch.ts";
import { width } from "./resources.ts";
import type { CrawlStorage, Frontier, Logged, OnPage } from "./frontier.ts";
import type { Router } from "./route.ts";
import { chromiumArguments } from "./resolve.ts";
import { TlsProber } from "./tls-probe.ts";

const SETTLE_MS = 5000;
// Pages a browser renders before a fresh one replaces it.
const RETIRE_AFTER_PAGES = 1000;
const LAUNCHERS: Record<BrowserName, BrowserType> = { chromium, firefox, webkit };
const PORT_ARGUMENT = "--remote-debugging-port=";
// Chromium past Crawlee’s loopback proxy, so it reports the server it reached.
const DIRECT = "--proxy-server=direct://";
// Each rendered page’s browser DevTools port, when an extractor asked for one.
const ports = new WeakMap<Page, number>();
const loaded = new WeakMap<Page, string>();

// The DevTools port of the browser rendering `page`; undefined unless an active extractor is `debugging`.
export function debuggingPort(page: Page): number | undefined {
    return ports.get(page);
}

// The digest of every sub-resource body `page` loaded; undefined when one failed, was not read, or a frame navigated.
export function loadedDigest(page: Page): string | undefined {
    return loaded.get(page);
}

// A loopback port free right now, for the next browser to listen on.
async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

type Transport = Pick<Facts, "tls"> & { headers: Record<string, string | string[]>; remote?: Facts["http"]["remote"]; security?: string };

// What one page load showed besides its DOM: the document response, console output, every sub-request.
interface Observation {
    document?: Response;
    transport?: Promise<Transport>;
    isDownload?: true;
    protocols: Map<string, string>;
    console: BrowserFacts["console"];
    requests: Request[];
}

// Headers, address and certificate of a document response; an unreadable one keeps no headers rather than failing the page.
async function readTransport(response: Response): Promise<Transport> {
    try {
        const [headers, address, security] = await Promise.all([response.headersArray(), response.serverAddr(), response.securityDetails()]);
        const tls = tlsFacts(security);
        return { headers: headerFacts(headers), remote: remoteFacts(address), ...(tls && { tls }), ...(security?.protocol && { security: security.protocol }) };
    } catch (error) {
        log.warn({ url: response.url(), error: String(error) }, "document transport unreadable");
        return { headers: {} };
    }
}

// Listens to a page before it navigates, so a download that aborts the navigation still leaves its response behind.
function observe(page: Page): Observation {
    const seen: Observation = { protocols: new Map(), console: { errors: [], warnings: [] }, requests: [] };
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

// Records per document URL the protocol Chromium’s network log names, `h3`, `h2` or `http/1.1`; other browsers record nothing.
async function watchProtocols(page: Page, seen: Observation): Promise<void> {
    try {
        const cdp = await page.context().newCDPSession(page);
        cdp.on("Network.responseReceived", ({ type, response }) => type === "Document" && response.protocol && seen.protocols.set(response.url, response.protocol));
        await cdp.send("Network.enable");
    } catch (error) {
        log.debug({ url: page.url(), error: String(error) }, "document protocol unobservable");
    }
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

// Http and tls facts of a document response, the prober filling what Chromium does not say; `size` is what the caller could measure of its body.
async function transportFacts(observation: Observation, size: Facts["http"]["size"], timing: Facts["http"]["timing"], isDirect: boolean, prober?: TlsProber, hop?: string): Promise<Pick<Facts, "http" | "tls">> {
    const response = observation.document as Response;
    const { headers, remote: seenRemote, tls: seen, security } = await (observation.transport as Promise<Transport>);
    const remote = isDirect ? seenRemote : undefined;
    const { type, charset } = contentTypeOf(headers["content-type"]);
    const url = new URL(response.url());
    const { tls, version } = withProbe(url.href, seen, security, await prober?.facts(url, remote?.address), hop);
    return {
        http: {
            status: response.status(),
            ...(version && { version }),
            redirects: await redirectFacts(response.request()),
            headers: redactHeaders(headers),
            ...(remote && { remote }),
            timing,
            cookies: cookieFacts(headers["set-cookie"], headers.date),
            size,
            "content-type": type,
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
    return { ...(domContentLoaded !== undefined && { "dom-content-loaded": domContentLoaded }), ...(load !== undefined && { load }) };
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

type Cheerio = Parameters<typeof extractHtml>[0];

// The document as served, before any script ran, and its html facts.
function staticHtml(raw: Buffer, url: URL, scope: Config["scope"]): { $: Cheerio; html: NonNullable<Facts["html"]> } {
    const source = raw.toString("utf8");
    const $ = load(source) as unknown as Cheerio;
    return { $, html: extractHtml($, source, url, scope) };
}

// The first URL of a redirect chain, without its fragment.
function requestedUrl(request: Request): string {
    let first = request;
    for (let previous = first.redirectedFrom(); previous; previous = previous.redirectedFrom()) first = previous;
    const url = new URL(first.url());
    url.hash = "";
    return url.href;
}

// Logs each finished sub-request’s final response once per URL, keeping a body under `max` only where `isKeptType` takes its type.
async function logResponses(requests: Request[], responses: Map<string, Logged>, max: number, isKeptType: (contentType: string) => boolean): Promise<void> {
    const finished = requests.filter((request) => !request.isNavigationRequest() && request.failure() === null && request.redirectedTo() === null && /^https?:/.test(request.url()));
    await Promise.all(
        finished.map(async (request) => {
            const url = requestedUrl(request);
            if (responses.has(url)) return;
            try {
                const response = await request.response();
                if (!response) return;
                const [headers, body] = await Promise.all([response.allHeaders(), response.body()]);
                const isKept = body.length < max && isKeptType(contentTypeOf(headers["content-type"]).type);
                const { responseEnd } = request.timing();
                const digest = createHash("sha256").update(body).digest("hex");
                responses.set(url, { status: response.status(), headers, bytes: body.length, ...(isKept && { body }), digest, ...(responseEnd >= 0 && { ms: Math.round(responseEnd) }) });
            } catch (error) {
                log.debug({ url, error: String(error) }, "browser response unreadable, fetched again later");
            }
        }),
    );
    log.debug({ finished: finished.length, logged: responses.size }, "browser responses logged");
}

// sha256 over each finished sub-request’s origin, path and body digest, sorted and distinct, so a cache-busting query or a repeated beacon keys nothing; undefined when one is unknown.
function resourcesDigest(requests: Request[], responses: Map<string, Logged>): string | undefined {
    const pairs = new Set<string>();
    for (const request of requests) {
        const isMainDocument = request.isNavigationRequest() && request.frame().parentFrame() === null;
        if (isMainDocument || request.redirectedTo() !== null || !/^https?:/.test(request.url())) continue;
        const url = requestedUrl(request);
        const digest = request.isNavigationRequest() || request.failure() !== null ? undefined : responses.get(url)?.digest;
        if (digest === undefined) {
            log.debug({ url, failure: request.failure()?.errorText, isFrame: request.isNavigationRequest() }, "page input unknown, extractors run uncached");
            return undefined;
        }
        const { origin, pathname } = new URL(url);
        pairs.add(`${origin}${pathname} ${digest}`);
    }
    return createHash("sha256").update([...pairs].toSorted((a, b) => a.localeCompare(b)).join("\n")).digest("hex");
}

// The Playwright launcher for `name`; a browser other than the bundled Chromium must be installed where Playwright looks.
function launcherOf(name: BrowserName): BrowserType {
    const launcher = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : undefined;
    if (!launcher) throw new ConfigError(`browser ${name}: expected chromium, firefox or webkit`);
    const executable = launcher.executablePath();
    const isInstalled = name === "chromium" || existsSync(executable);
    log.debug({ browser: name, executable, isInstalled }, "browser chosen");
    if (!isInstalled) throw new ConfigError(`browser ${name} is not installed (expected ${executable}); install it with: npx playwright install ${name}`);
    return launcher;
}

// What a browser crawl spent and kept: pages rendered, browser launches, sub-resource responses by requested URL, TLS probes.
export interface BrowserStats {
    pages: number;
    launches: number;
    responses: Map<string, Logged>;
    tlsProbes: number;
}

// The browser crawler of a frontier: facts come from the rendered DOM and the browser’s own network log; an adaptive group’s rendered page is compared with its static HTML.
export function browserCrawler(config: Config, onPage: OnPage, frontier: Frontier, router: Router, storage?: CrawlStorage, proxy?: string, isKeptType: (contentType: string) => boolean = () => false, isDebugged = false, isExpensive = false): { crawler: PlaywrightCrawler; stats(): BrowserStats } {
    const launcher = launcherOf(config.browser);
    const isPortOpen = isDebugged && config.browser === "chromium";
    if (isDebugged && !isPortOpen) log.warn({ browser: config.browser }, "only Chromium opens a DevTools port; its extractors add nothing");
    let pages = 0;
    const observations = new WeakMap<CrawleeRequest, Observation>();
    const responses = new Map<string, Logged>();
    const prober = proxy ? undefined : new TlsProber(config.allowPrivate);
    if (proxy) log.warn({ fetch: "browser" }, "TLS probes would bypass the proxy; browser pages carry no cipher, ALPN, SAN or HTTP version");
    const isDirect = !proxy && config.browser === "chromium";
    log.debug({ browser: config.browser, isDirect }, "browser remote address recorded only when direct");
    let launches = 0;
    // Pages rendered at once, all in one browser: `concurrency`, else one beside an expensive extractor, else half of NUMPROCS.
    const openPages = config.concurrency || (isExpensive ? 1 : Math.ceil(width() / 2));
    log.debug({ openPages, concurrency: config.concurrency, isExpensive }, "browser concurrency");
    const crawler = new Crawler(
        {
            ...frontier.options("browser", storage, proxy),
            headless: true,
            // Snapshot with `page.content()`; crawlee’s shadow-root expansion writes `innerHTML` into the live page.
            ignoreShadowRoots: true,
            maxConcurrency: openPages,
            launchContext: { launcher, userAgent: USER_AGENT, launchOptions: { args: config.browser === "chromium" ? [...chromiumArguments(), ...(proxy ? [] : [DIRECT])] : [] } },
            browserPoolOptions: {
                useFingerprints: false,
                maxOpenPagesPerBrowser: openPages,
                retireBrowserAfterPageCount: RETIRE_AFTER_PAGES,
                preLaunchHooks: isPortOpen
                    ? [
                          async (pageId, launchContext) => {
                              const port = await freePort();
                              launchContext.launchOptions = { ...launchContext.launchOptions, args: [...(launchContext.launchOptions?.args ?? []), `${PORT_ARGUMENT}${port}`] };
                              log.debug({ pageId, port }, "browser DevTools port opened on loopback");
                          },
                      ]
                    : [],
                postLaunchHooks: [
                    (pageId) => {
                        launches += 1;
                        log.debug({ pageId, launches }, "browser launched");
                    },
                ],
            },
            preNavigationHooks: [
                async ({ page, request }) => {
                    const observation = observe(page);
                    observations.set(request, observation);
                    await watchProtocols(page, observation);
                    await page.addInitScript({ content: COOKIE_WRITES });
                },
            ],
            async requestHandler({ request, page, parseWithCheerio, enqueueLinks, browserController }) {
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
                const wire = observation.isDownload ? 0 : await wireSize(response.request(), raw.length);
                const size = { body: wire, decoded: raw.length, ...declaredSize(headers), ...((body.length < text.length || observation.isDownload) && { truncated: true as const }) };
                const timing = observation.isDownload ? {} : timingFacts(response.request().timing());
                const facts: Facts = { ...frontier.identity(request, url), ...(await transportFacts(observation, size, timing, isDirect, prober, observation.protocols.get(response.url()))) };
                const { startTime, requestStart, responseStart } = response.request().timing();
                const skew = observation.isDownload || responseStart < 0 ? undefined : dateSkew(url.href, headers, startTime + requestStart, startTime + responseStart);
                if (skew !== undefined) facts.http["date-skew"] = skew;
                const served = isHtml ? staticHtml(raw, url, config.scope) : undefined;
                if (isHtml && served) {
                    const $ = await parseWithCheerio();
                    facts.html = extractHtml($, text, url, config.scope);
                    facts.parity = parityFacts(url.href, served.$, served.html, $, facts.html);
                    facts.resources = observedResources(extractResources($, url, config.maxResourcesPerPage), observation.requests, url, config.maxResourcesPerPage);
                    facts.browser = { timing: await milestones(page), console: observation.console, weight: await weightFacts(observation.requests), cookies: await scriptCookies(page) };
                    await logResponses(observation.requests, responses, config.maxBodySize, isKeptType);
                    const digest = resourcesDigest(observation.requests, responses);
                    if (digest) loaded.set(page, digest);
                }
                log.debug({ url: url.href, status: facts.http.status, type, bytes: size.body, depth: facts.crawl.depth, settled, isDownload: observation.isDownload === true, requests: observation.requests.length }, "page rendered");
                if (router.isDetecting(url.href)) router.detected(url.href, served?.html, facts.html);
                pages += 1;
                const port = browserController.launchContext.launchOptions?.args?.findLast((argument) => argument.startsWith(PORT_ARGUMENT))?.slice(PORT_ARGUMENT.length);
                if (port) ports.set(page, Number(port));
                await onPage(facts, body, isHtml ? page : undefined);
                if (!isHtml) return;
                log.debug({ url: url.href, enqueued: await frontier.enqueue(enqueueLinks, facts, "browser") }, "links enqueued");
            },
            async failedRequestHandler({ request }, error) {
                const facts = frontier.failed(request, reason(error));
                if (facts) await onPage(facts, "");
            },
        },
        storage?.config ?? new Configuration({ persistStorage: false, purgeOnStart: false }),
        observations,
    );
    if (storage?.earlier) log.debug({ fetch: "browser" }, "browser pages are re-rendered, never revalidated");
    return { crawler, stats: () => ({ pages, launches, responses, tlsProbes: prober?.probes ?? 0 }) };
}
