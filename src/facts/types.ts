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
}

// One sitemap file as fetched: its status, how many page and nested sitemap URLs it names, why it failed.
export interface SitemapFileFacts {
    url: string;
    status: number;
    urls: number;
    sitemaps: number;
    error?: string;
}

// Facts about the site rather than any one page, read by group and site rules.
export interface SiteFacts {
    sitemaps: SitemapFileFacts[];
    redirects?: Record<string, string>;
}

export interface CookieFacts {
    name: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite?: string;
}

export interface HttpFacts {
    status: number;
    version?: string;
    redirects: { url: string }[];
    headers: Record<string, string | string[]>;
    remote?: { address: string; family?: string };
    timing: Partial<Record<"wait" | "dns" | "tcp" | "tls" | "request" | "ttfb" | "download" | "total", number>>;
    cookies: CookieFacts[];
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
    title?: string;
    h1: string[];
    canonical?: string;
    meta: Record<string, string>;
    property: Record<string, string>;
    links: { internal: string[]; external: string[]; nofollow: string[] };
    images: { src: string; alt?: string }[];
}

export interface ResourceFacts {
    url: string;
    kind: "script" | "style" | "image" | "font" | "iframe" | "preload";
    origin: "same" | "cross";
    integrity?: string;
    crossorigin?: string;
    observed?: true;
    http?: { status: number; headers: Record<string, string | string[]>; contentType?: string; size: { body: number }; timing: { total?: number }; error?: string; cached?: true; revalidated?: true };
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
    http: HttpFacts;
    tls?: TlsFacts;
    html?: HtmlFacts;
    resources?: ResourceFacts[];
    browser?: BrowserFacts;
    // A plugin extractor’s facts, under the extractor’s ID.
    [extractor: string]: unknown;
}
