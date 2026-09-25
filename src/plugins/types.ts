// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Page } from "playwright";
import type { Probe, ProbeInit } from "../crawl/probe.ts";
import type { Facts } from "../facts/types.ts";
import type { Make, RulesetConfig } from "../rules/types.ts";

// Facts from one fetched page and its body, stored under `id`; undefined adds nothing.
export interface Extractor {
    id: string;
    // `browser` runs only on a rendered page, handed over as `live`, and forces the browser crawl.
    mode?: "browser";
    extract(page: Facts, body: string, live?: Page): Promise<unknown>;
}

// What a site extractor may touch: its subject’s pages, and GET or HEAD probes that stay on its host.
export interface SiteContext {
    fetch(url: string, init?: ProbeInit): Promise<Probe>;
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
    extract(subject: string, context: SiteContext): Promise<unknown>;
}

// A plugin module’s default export.
export interface Plugin {
    name: string;
    extractors?: Extractor[];
    sites?: SiteExtractor[];
    rules?: Record<string, Make>;
    presets?: Record<string, RulesetConfig>;
}

// Types a plugin’s default export.
export function definePlugin(plugin: Plugin): Plugin {
    return plugin;
}
