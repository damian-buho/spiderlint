// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import type { Paint } from "../color.ts";
import type { DnsClient } from "../crawl/dns.ts";
import type { Probe, ProbeInit } from "../crawl/probe.ts";
import type { Facts, LinkFacts } from "../facts/types.ts";
import type { Report } from "../index.ts";
import type { Make, RulesetConfig } from "../rules/types.ts";

// Facts from one fetched page and its body, stored under `id`; undefined adds nothing.
export interface Extractor {
    id: string;
    // `browser` runs only on a rendered page, handed over as `live`, and forces the browser crawl.
    mode?: "browser";
    // `expensive` runs on at most the group’s `sample` pages; `cheap`, the default, on every page.
    cost?: "cheap" | "expensive";
    // Keys the `extractors` bucket; a plugin extractor without one is never cached, a bundled one is spiderlint’s version.
    version?: string;
    // `false` runs on every crawl, for an extractor reading more than its page’s body, URL and content type.
    cached?: false;
    extract(page: Facts, body: string, live?: Page, context?: PageContext): Promise<unknown>;
}

// What a page extractor may touch while crawling: GET or HEAD probes that stay on the page’s host; absent when a stored page is backfilled.
export interface PageContext {
    fetch(url: string, init?: ProbeInit): Promise<Probe>;
    signal: AbortSignal;
}

// Facts from one fetched resource body, stored under `id` on each page’s entry for its URL; undefined adds nothing.
export interface ResourceExtractor {
    id: string;
    // Content-type prefixes whose bodies it reads (`image/`).
    types: string[];
    // Keys the `extractors` bucket, as a page extractor’s does.
    version?: string;
    cached?: false;
    extract(url: string, contentType: string, body: Uint8Array): Promise<unknown>;
}

// What a site extractor may touch: its subject’s pages, GET or HEAD probes that stay on its host, cached link answers from any host, and DNS queries to the configured resolver.
export interface SiteContext {
    fetch(url: string, init?: ProbeInit): Promise<Probe>;
    // A link’s status through the `probes` bucket, as `links/broken-external` probes it.
    link(url: string): Promise<LinkFacts>;
    dns: DnsClient;
    pages: readonly Facts[];
    signal: AbortSignal;
}

// Facts about one origin or host, run once per subject after the crawl and stored under `site.origins` or `site.hosts`.
export interface SiteExtractor {
    id: string;
    // `origin`: scheme, host and port; `host`: a DNS name.
    per: "origin" | "host";
    // Milliseconds before the run gives up on one subject; 60 s when unset.
    timeout?: number;
    // `false` skips the `origins` bucket and runs on every crawl, for an extractor whose queries cache themselves.
    cached?: false;
    // Queries DNS directly, which no proxy carries, so a proxied run skips it.
    resolves?: true;
    extract(subject: string, context: SiteContext): Promise<unknown>;
}

// A report as text; `isFull` when folding is off.
export type Formatter = (report: Report, paint: Paint, isFull: boolean) => string;

// URLs for the frontier, read from what follows `<id>:` in `sources`.
export interface Source {
    id: string;
    // `false` makes its URLs the whole frontier: no link or sitemap URL joins them.
    follow?: false;
    urls(argument: string, signal: AbortSignal): Promise<string[]>;
}

// A plugin module’s default export.
export interface Plugin {
    name: string;
    extractors?: Extractor[];
    sites?: SiteExtractor[];
    resources?: ResourceExtractor[];
    rules?: Record<string, Make>;
    presets?: Record<string, RulesetConfig>;
    formatters?: Record<string, Formatter>;
    sources?: Source[];
}

// Types a plugin’s default export.
export function definePlugin(plugin: Plugin): Plugin {
    return plugin;
}
