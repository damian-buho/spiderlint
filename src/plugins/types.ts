// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import type { Bucket } from "../cache/index.ts";
import type { Paint } from "../color.ts";
import type { DnsClient } from "../crawl/dns.ts";
import type { Probe, ProbeInit } from "../crawl/probe.ts";
import type { Cached } from "../crawl/profile.ts";
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
    // `false` runs on every crawl, for an extractor reading more than its page’s body, URL, content type and `inputs`.
    cached?: false;
    // What else keys its entry: the `Link` header, or every body the rendered page loaded; a `browser` extractor adds the browser and its version.
    inputs?: ("headers.link" | "resources")[];
    // Opens Chromium’s DevTools port on loopback for the run, read back through `debuggingPort(live)`.
    debugging?: true;
    extract(page: Facts, body: string, live?: Page, context?: PageContext): Promise<unknown>;
}

// What a page extractor may touch while crawling: GET or HEAD probes that stay on the page’s host; absent when a stored page is backfilled.
export interface PageContext {
    fetch(url: string, init?: ProbeInit): Promise<Probe>;
    // Whether robots.txt lets spiderlint load `url`, on any host; true when the run ignores robots.txt.
    allowed(url: string): Promise<boolean>;
    // The `profiles` bucket, for a verdict about another host’s page that stays true for a while; a key of its own never meets a page’s URL.
    profiles: Bucket<unknown>;
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
    // A GET or HEAD on the host `url` names, for a file the subject delegates there; the address guard and robots.txt apply.
    delegated(url: string, init?: ProbeInit): Promise<Probe>;
    // A GET on another host answered from the `profiles` bucket while fresh, else revalidated; robots.txt applies, and the answer says when it was last confirmed.
    cached(url: string): Promise<Cached>;
    // A link’s status through the `probes` bucket, as `links/broken-external` probes it.
    link(url: string): Promise<LinkFacts>;
    dns: DnsClient;
    // The address a raw socket or external tool may connect to for a host; a private one throws unless allowed.
    address(host: string): Promise<string>;
    // The subject’s crawled pages; for a linked host, the pages that link or load it.
    pages: readonly Facts[];
    signal: AbortSignal;
    // Set when the subject is a host the crawl only links or loads, never crawled.
    linked?: true;
    // The plugin’s validated settings, when it declares any.
    settings?: unknown;
}

// Facts about one origin or host, run once per subject after the crawl and stored under `site.origins` or `site.hosts`.
export interface SiteExtractor {
    id: string;
    // `origin`: scheme, host and port; `host`: a DNS name.
    per: "origin" | "host";
    // With `per: host`, also each crawled host’s registrable domain, holding every page under it.
    domains?: true;
    // Keys the `origins` bucket, as a page extractor’s keys the `extractors` bucket.
    version?: string;
    // Milliseconds before the run gives up on one subject; 60 s when unset.
    timeout?: number;
    // `false` skips the `origins` bucket and runs on every crawl, for an extractor whose queries cache themselves.
    cached?: false;
    // Queries DNS or connects directly, which no proxy carries, so a proxied run skips it.
    resolves?: true;
    // Reads every crawled page, so a run of its rules alone still crawls past the seeds.
    crawled?: true;
    // Set by the registry to the plugin’s validated settings, which also key the `origins` bucket.
    settings?: unknown;
    extract(subject: string, context: SiteContext): Promise<unknown>;
}

// A report as text; `isFull` when folding is off, `lang` the reader’s language when a formatter translates, `isHintListed` to list hints a formatter collapses, `isExplained` to print each finding’s fix.
export type Formatter = (report: Report, paint: Paint, isFull: boolean, lang?: string, isHintListed?: boolean, isExplained?: boolean, isStats?: boolean) => string;

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
    // JSON Schema of its `org.spiderlint.<name>` key; its defaults fill what the key leaves out.
    settings?: Record<string, unknown>;
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
