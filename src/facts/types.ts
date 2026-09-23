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
}

export interface CrawlFacts {
    depth: number;
    discoveredVia: "seed" | "sitemap" | "link";
    referrers: string[];
}

export interface SitemapFacts {
    listed: boolean;
    lastmod?: string;
    changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
    priority?: number;
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

export interface Facts {
    url: UrlFacts;
    group: string;
    crawl: CrawlFacts;
    sitemap?: SitemapFacts;
    http: HttpFacts;
    tls?: TlsFacts;
    html?: HtmlFacts;
}
