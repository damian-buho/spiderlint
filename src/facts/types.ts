// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export interface UrlFacts {
    href: string;
    origin: string;
    protocol: string;
    host: string;
    pathname: string;
    search: string;
    twin?: string;
}

export interface CrawlFacts {
    depth: number;
    "discovered-via": "seed" | "sitemap" | "link";
    referrers: string[];
    requested?: string;
}

export interface SitemapFacts {
    listed: boolean;
    lastmod?: string;
    changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
    priority?: number;
    // `xhtml:link` hreflang alternates of the entry, as written.
    alternates?: { lang: string; href: string }[];
    // `image:loc`, and `video:content_loc` or `video:player_loc`, of the entry.
    images?: string[];
    videos?: string[];
}

// One sitemap file as fetched: its status, how many page and nested sitemap URLs it names, why it failed.
export interface SitemapFileFacts {
    url: string;
    status: number;
    urls: number;
    sitemaps: number;
    error?: string;
}

// One off-scope link’s probe answer; status 0 is no answer, `refused` a private address the guard kept closed, `walled` a bot wall answering instead of the page, `excluded` a host `links.exclude` names.
export interface LinkFacts {
    status: number;
    method?: "HEAD" | "GET";
    error?: string;
    refused?: true;
    walled?: true;
    excluded?: true;
}

// One `robots.txt` group: the agents it names and the rules it gives them.
export interface RobotsGroupFacts {
    agents: string[];
    allow: string[];
    disallow: string[];
    "crawl-delay"?: number;
}

// One `Content-Signal` line, its agents empty outside a group, its signals as written.
export interface ContentSignalFacts {
    agents: string[];
    value: string;
    signals: Record<string, string>;
}

// One origin’s `robots.txt` as fetched; status 0 is no answer, and only a 2xx body is parsed.
export interface RobotsFileFacts {
    url: string;
    status: number;
    error?: string;
    groups: RobotsGroupFacts[];
    sitemaps: string[];
    "content-signals": ContentSignalFacts[];
}

// What the audited site is for; set from the config on every lint.
export type Role = "production" | "staging" | "development";

// Facts about the site rather than any one page, read by group and site rules.
export interface SiteFacts {
    role?: Role;
    sitemaps: SitemapFileFacts[];
    robots?: RobotsFileFacts[];
    redirects?: Record<string, string>;
    // Probe answers by off-scope link URL.
    links?: Record<string, LinkFacts>;
    // Site extractor facts by origin, then by extractor ID.
    origins?: Record<string, Record<string, unknown>>;
    // Site extractor facts by hostname, then by extractor ID.
    hosts?: Record<string, Record<string, unknown>>;
    // Hosts in `hosts` the crawl only links or loads, judged by `linked` rules alone.
    linked?: string[];
    // The internal link graph: pages, distinct edges, and whether a crawl limit cut it short.
    graph?: { pages: number; edges: number; capped?: true };
}

// A page’s place in the internal link graph, derived on every lint.
export interface GraphFacts {
    // Fewest links from a seed; absent when no link path reaches the page.
    depth?: number;
    "in-degree": number;
    "out-degree": number;
    // PageRank scaled so the average page is 1.
    rank: number;
}

export interface CookieFacts {
    name: string;
    secure: boolean;
    "http-only": boolean;
    "same-site"?: string;
    path?: string;
    domain?: string;
    "max-age"?: number;
}

export interface RedirectHop {
    url: string;
    status?: number;
    headers?: Record<string, string | string[]>;
    // `X-Redirect-By` or `Redirect-By`: the software that answered the hop.
    by?: string;
}

export interface HttpFacts {
    status: number;
    version?: string;
    // Each hop’s target, with the status and headers of the response that sent the crawler there.
    redirects: RedirectHop[];
    headers: Record<string, string | string[]>;
    remote?: { address: string; family?: string };
    timing: Partial<Record<"wait" | "dns" | "tcp" | "tls" | "request" | "ttfb" | "download" | "total", number>>;
    cookies: CookieFacts[];
    // The `Link` header of each 103 Early Hints response before the final one.
    "early-hints"?: { link?: string }[];
    size: { body: number; decoded: number; declared?: number; truncated?: true };
    "content-type": string;
    charset?: string;
    revalidated?: true;
    // Seconds `Date` runs ahead of the crawler’s clock, halfway through the round trip; absent when served from a cache.
    "date-skew"?: number;
    // Why no attempt fetched the page; the status is then 0.
    error?: string;
    // The Content-Security-Policy headers and `<meta>` policies, derived on every lint.
    csp?: CspFacts;
}

// Enforced policies combined as the browser enforces them: each directive keeps only the sources every policy governing it allows.
export interface CspFacts {
    policies: number;
    directives?: Record<string, string[]>;
    "report-only"?: { policies: number; directives: Record<string, string[]> };
}

export interface TlsFacts {
    protocol?: string;
    cipher?: string;
    alpn?: string;
    authorized: boolean;
    error?: string;
    cert: { subject?: string; issuer?: string; "not-before"?: string; "not-after"?: string; "days-left"?: number; san: string[]; fingerprint256?: string; key?: { type: string; bits?: number; curve?: string }; signatures?: string[] };
}

export interface HtmlFacts {
    lang?: string;
    dir?: string;
    charset?: { declared: string; offset: number };
    title?: string;
    h1: string[];
    canonical?: string;
    meta: Record<string, string>;
    metas: { name: string; content: string; media?: string }[];
    "http-equiv"?: { name: string; content: string }[];
    property: Record<string, string>;
    head: { links: Partial<Record<"rel" | "href" | "type" | "hreflang" | "sizes" | "media" | "as" | "crossorigin", string>>[] };
    hreflang: { lang: string; href: string }[];
    jsonld: unknown[];
    scripts: { src?: string; type?: string; async: boolean; defer: boolean; head: boolean }[];
    // `rel`: the tokens every anchor to an href carries; absent on facts stored before it.
    links: { internal: string[]; external: string[]; nofollow: string[]; sponsored?: string[]; ugc?: string[]; rel?: Record<string, string[]> };
    images: { src: string; alt?: string; width?: string; height?: string; srcset?: string; loading?: string; noscript?: true }[];
    rels: Record<string, string[]>;
    inputs: { type: string; autocomplete?: string; inputmode?: string }[];
    // The language of the title and description, derived on every lint that reads it.
    detected?: DetectedFacts;
    // Author and publication date, resolved from JSON-LD then the head on every lint.
    author?: string;
    published?: string;
}

// One string’s language: an ISO 639-1 code, eld’s top score, and whether eld calls the guess reliable.
export interface LanguageGuess {
    language: string;
    confidence: number;
    reliable: boolean;
}

export interface DetectedFacts {
    title?: LanguageGuess;
    description?: LanguageGuess;
}

// Indexing directives merged from `<meta name=robots>` and `X-Robots-Tag`.
export interface RobotsFacts {
    noindex: boolean;
    nofollow: boolean;
}

export interface ResourceFacts {
    url: string;
    kind: "script" | "style" | "image" | "font" | "iframe" | "preload" | "manifest";
    origin: "same" | "cross";
    integrity?: string;
    crossorigin?: string;
    observed?: true;
    http?: { status: number; headers: Record<string, string | string[]>; "content-type"?: string; size: { body: number }; timing: { total?: number }; cookies?: CookieFacts[]; error?: string; cached?: true; revalidated?: true; logged?: true };
    // A resource extractor’s facts, under the extractor’s ID.
    [extractor: string]: unknown;
}

// What only a rendering browser sees: load milestones, console output, bytes per resource kind.
export interface BrowserFacts {
    timing: { "dom-content-loaded"?: number; load?: number };
    console: { errors: string[]; warnings: string[] };
    weight: Partial<Record<"script" | "style" | "image" | "font", number>>;
    // Cookies the page’s scripts wrote through `document.cookie`, without values.
    cookies: CookieFacts[];
}

// What a crawler reading one render of a page sees: text is characters in `<main>`, else `<body>`; links counts internal ones.
export interface ParitySide {
    title?: string;
    description?: string;
    canonical?: string;
    h1: string[];
    text: number;
    links: number;
}

// The raw HTML and the rendered DOM of one page, browser mode only; `missing` holds what only the render carries.
export interface ParityFacts {
    raw: ParitySide;
    rendered: ParitySide;
    missing: { title?: string; description?: string; canonical?: string; h1?: string[]; links?: string[] };
    // Raw text length over rendered text length, when the render has text.
    "text-share"?: number;
}

// Emissions per view of one page by the Sustainable Web Design model, derived on a lint that reads them.
export interface Co2Facts {
    model: "swd";
    version: 4;
    library: string;
    // Transfer bytes of the page and of each distinct resource with a known size.
    bytes: number;
    resources: number;
    grams: number;
    // The model’s letter, A+ to F.
    rating: string;
}

export interface Facts {
    url: UrlFacts;
    group: string;
    crawl: CrawlFacts;
    sitemap?: SitemapFacts;
    robots?: RobotsFacts;
    graph?: GraphFacts;
    http: HttpFacts;
    tls?: TlsFacts;
    html?: HtmlFacts;
    resources?: ResourceFacts[];
    browser?: BrowserFacts;
    parity?: ParityFacts;
    co2?: Co2Facts;
    // A plugin extractor’s facts, under the extractor’s ID.
    [extractor: string]: unknown;
}
