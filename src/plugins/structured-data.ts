// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule, resolve } from "../rules/builtin.ts";
import type { Finding, Make } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

type Node = Record<string, unknown>;

const GALLERY = "https://developers.google.com/search/docs/appearance/structured-data/search-gallery";

// Properties a rich result requires per schema.org type, from Google Search Central’s per-feature pages as of 2026-09-25; refreshed by hand.
const REQUIRED: Record<string, string[]> = {
    BreadcrumbList: ["itemListElement"],
    Course: ["name", "description"],
    Dataset: ["name", "description"],
    Event: ["name", "startDate", "location"],
    FAQPage: ["mainEntity"],
    JobPosting: ["title", "description", "datePosted", "hiringOrganization"],
    LocalBusiness: ["name", "address"],
    Product: ["name"],
    Recipe: ["name", "image"],
    Review: ["author", "itemReviewed", "reviewRating"],
    VideoObject: ["name", "thumbnailUrl", "uploadDate"],
};

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

// The top-level nodes of every parsed block: each object, array entry and `@graph` member.
function nodesOf(page: Facts): Node[] {
    const blocks = (page.html?.jsonld ?? []).flatMap((block) => (Array.isArray(block) ? block : [block])).filter((block) => isNode(block) && !("@error" in block));
    return blocks.flatMap((block) => (Array.isArray(block["@graph"]) ? block["@graph"].filter(isNode) : [block]));
}

// A node’s types, a bare name for a schema.org IRI.
function typesOf(node: Node): string[] {
    const raw = node["@type"];
    return (Array.isArray(raw) ? raw : [raw]).filter((type): type is string => typeof type === "string").map((type) => type.replace(/^https?:\/\/schema\.org\//, ""));
}

// Present and not empty.
const isSet = (value: unknown) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

const parse = pageRule("structured-data/parse", ["html.jsonld"], (page) => {
    if (!page.html) return;
    const errors = page.html.jsonld.filter((block): block is { "@error": string } => isNode(block) && typeof block["@error"] === "string").map((block) => block["@error"]);
    return errors.length === 0 ? [] : [{ message: `${errors.length} JSON-LD block${errors.length === 1 ? " does" : "s do"} not parse: ${errors.join("; ")}`, value: errors }];
}, { docs: "https://json-ld.org/spec/latest/json-ld/", fix: "Serialise the JSON-LD with a JSON encoder instead of a text template, so quotes and newlines in values are escaped." });

const required = pageRule("structured-data/required", ["html.jsonld"], (page) => {
    if (!page.html) return;
    const locations = nodesOf(page).flatMap((node) => typesOf(node).flatMap((type) => {
        const missing = (REQUIRED[type] ?? []).filter((property) => !isSet(node[property]));
        return missing.length === 0 ? [] : [`${type} without ${missing.join(", ")}`];
    }));
    return locations.length === 0 ? [] : [{ message: `${locations.length} JSON-LD node${locations.length === 1 ? " lacks" : "s lack"} properties their rich result requires`, value: locations, locations }];
}, { docs: GALLERY, fix: "Add the missing properties to each named node, or drop a type the page does not really describe." });

// The URL a `ListItem.item` names: a string, or a node’s `@id` or `url`.
function itemUrl(item: unknown): string | undefined {
    if (typeof item === "string") return item;
    if (!isNode(item)) return undefined;
    const url = item["@id"] ?? item.url;
    return typeof url === "string" ? url : undefined;
}

// Absolute URLs the page’s breadcrumb lists name.
function crumbsOf(page: Facts): string[] {
    const lists = nodesOf(page).filter((node) => typesOf(node).includes("BreadcrumbList"));
    const items = lists.flatMap((list) => (Array.isArray(list.itemListElement) ? list.itemListElement.filter(isNode) : []));
    return [...new Set(items.flatMap((item) => itemUrl(item.item) ?? []).map((url) => resolve(url, page.url.href)))];
}

// Every breadcrumb target the crawl found answering outside 2xx or redirecting, once per target, with the pages naming it.
const breadcrumbs: Make = (severity) => ({
    meta: { id: "structured-data/breadcrumbs", severity, scope: "site", facts: ["html.jsonld", "http.status", "site.redirects"], docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb", fix: "Point each breadcrumb `item` at the final URL of a page that answers 200." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const status = new Map(pages.map((page) => [page.url.href, page.http.status]));
        const redirects = site?.redirects ?? {};
        const naming = new Map<string, string[]>();
        for (const page of pages) for (const url of crumbsOf(page)) naming.set(url, [...(naming.get(url) ?? []), page.url.href]);
        const findings: Finding[] = [];
        for (const [url, urls] of naming) {
            const [answer, landing] = [status.get(url), redirects[url]];
            log.debug({ rule: "structured-data/breadcrumbs", url, status: answer, landing, pages: urls.length }, "breadcrumb judged");
            const verdict = landing ? `redirects to ${landing}` : answer !== undefined && (answer < 200 || answer > 299) ? `answers ${answer}` : undefined;
            if (verdict) findings.push({ rule: "structured-data/breadcrumbs", severity, scope: "site", url, message: `breadcrumb item ${verdict}; named by ${urls.length} page${urls.length === 1 ? "" : "s"}`, value: landing ?? answer, urls });
        }
        return findings;
    },
});

export default definePlugin({
    name: "structured-data",
    rules: { "structured-data/parse": parse, "structured-data/required": required, "structured-data/breadcrumbs": breadcrumbs },
    presets: {
        "structured-data": {
            description: "JSON-LD that parses, carries what its rich result requires, and whose breadcrumbs lead to live pages",
            rules: { "structured-data/parse": "error", "structured-data/required": "warning", "structured-data/breadcrumbs": "warning" },
        },
    },
});
