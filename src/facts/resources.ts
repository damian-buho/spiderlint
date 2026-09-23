// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { CheerioCrawlingContext } from "crawlee";
import type { ResourceFacts } from "./types.ts";

type CheerioAPI = CheerioCrawlingContext["$"];

// Selector, resource kind and the attribute holding its URL.
const SOURCES: [string, ResourceFacts["kind"], string][] = [
    ["script[src]", "script", "src"],
    ['link[rel~="stylesheet"][href]', "style", "href"],
    ["img[src]", "image", "src"],
    ["iframe[src]", "iframe", "src"],
    ['link[rel~="preload"][href]', "preload", "href"],
];

// Every candidate URL of a `srcset`, descriptors dropped.
function srcset(raw: string | undefined): string[] {
    return (raw ?? "").split(",").map((entry) => entry.trim().split(/\s+/, 1)[0] ?? "").filter((entry) => entry.length > 0);
}

// The http(s) URL `raw` names relative to the page, or undefined.
function resolve(raw: string, page: URL): URL | undefined {
    if (!URL.canParse(raw, page)) return undefined;
    const url = new URL(raw, page);
    url.hash = "";
    return /^https?:$/.test(url.protocol) ? url : undefined;
}

// Sub-requests the static document declares, one entry per URL and kind, at most `max`.
export function extractResources($: CheerioAPI, page: URL, max: number): ResourceFacts[] {
    const found = new Map<string, ResourceFacts>();
    for (const [selector, kind, attribute] of SOURCES) {
        $(selector).each((_, element) => {
            const node = $(element);
            const raws = [String(node.attr(attribute)), ...(kind === "image" ? srcset(node.attr("srcset")) : [])];
            for (const raw of raws) {
                const url = resolve(raw, page);
                if (!url || found.has(`${kind} ${url.href}`)) continue;
                const integrity = node.attr("integrity");
                const crossorigin = node.attr("crossorigin");
                found.set(`${kind} ${url.href}`, { url: url.href, kind, origin: url.origin === page.origin ? "same" : "cross", ...(integrity && { integrity }), ...(crossorigin !== undefined && { crossorigin }) });
            }
        });
    }
    return found.values().take(max).toArray();
}
