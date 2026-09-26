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
    discoveredVia: "seed" | "sitemap" | "link";
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
    crawlDelay?: number;
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
    contentSignals: ContentSignalFacts[];
}

// Facts about the site rather than any one page, read by group and site rules.
export interface SiteFacts {
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
}

export interface CookieFacts {
    name: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
    path?: string;
    domain?: string;
    maxAge?: number;
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
    earlyHints?: { link?: string }[];
    size: { body: number; decoded: number; declared?: number; truncated?: true };
    contentType: string;
    charset?: string;
    revalidated?: true;
}

export interface TlsFacts {
    protocol?: string;
    cipher?: string;
    alpn?: string;
    authorized: boolean;
    error?: string;
    cert: { subject?: string; issuer?: string; notBefore?: string; notAfter?: string; daysLeft?: number; san: string[]; fingerprint256?: string };
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
    property: Record<string, string>;
    head: { links: Partial<Record<"rel" | "href" | "type" | "hreflang" | "sizes" | "media" | "as" | "crossorigin", string>>[] };
    hreflang: { lang: string; href: string }[];
    jsonld: unknown[];
    scripts: { src?: string; type?: string; async: boolean; defer: boolean; head: boolean }[];
    links: { internal: string[]; external: string[]; nofollow: string[] };
    images: { src: string; alt?: string; width?: string; height?: string; srcset?: string; loading?: string; noscript?: true }[];
    rels: Record<string, string[]>;
    inputs: { type: string; autocomplete?: string; inputmode?: string }[];
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
    http?: { status: number; headers: Record<string, string | string[]>; contentType?: string; size: { body: number }; timing: { total?: number }; error?: string; cached?: true; revalidated?: true; logged?: true };
    // A resource extractor’s facts, under the extractor’s ID.
    [extractor: string]: unknown;
}

// What only a rendering browser sees: load milestones, console output, bytes per resource kind.
export interface BrowserFacts {
    timing: { domContentLoaded?: number; load?: number };
    console: { errors: string[]; warnings: string[] };
    weight: Partial<Record<"script" | "style" | "image" | "font", number>>;
}

export interface Facts {
    url: UrlFacts;
    group: string;
    crawl: CrawlFacts;
    sitemap?: SitemapFacts;
    robots?: RobotsFacts;
    http: HttpFacts;
    tls?: TlsFacts;
    html?: HtmlFacts;
    resources?: ResourceFacts[];
    browser?: BrowserFacts;
    // A plugin extractor’s facts, under the extractor’s ID.
    [extractor: string]: unknown;
}
