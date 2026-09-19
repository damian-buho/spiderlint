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

export interface HttpFacts {
    status: number;
    headers: Record<string, string | string[]>;
    size: { body: number };
    contentType: string;
    charset?: string;
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
    http: HttpFacts;
    html?: HtmlFacts;
}
