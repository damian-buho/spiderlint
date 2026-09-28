// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { HtmlFacts } from "./types.ts";

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

// Every JSON-LD node, through arrays and `@graph`, in document order.
const nodesOf = (value: unknown): Node[] => (Array.isArray(value) ? value.flatMap((item) => nodesOf(item)) : isNode(value) ? [value, ...nodesOf(value["@graph"])] : []);

// A schema.org `author` as a name: a string, a node’s `name`, or the first of a list.
const nameOf = (value: unknown): string | undefined => (typeof value === "string" ? value : Array.isArray(value) ? nameOf(value[0]) : isNode(value) && typeof value.name === "string" ? value.name : undefined);

// Author and publication date the way a link preview resolves them: JSON-LD first, then the head tags.
export function bylineFacts(html: HtmlFacts): Pick<HtmlFacts, "author" | "published"> {
    const nodes = nodesOf(html.jsonld);
    const author = nodes.map((node) => nameOf(node.author)).find(Boolean) ?? html.property["article:author"] ?? html.meta.author ?? html.property["og:author"] ?? html.meta["og:author"];
    const published = nodes.map((node) => node.datePublished).find((value): value is string => typeof value === "string") ?? html.property["article:published_time"];
    log.debug({ nodes: nodes.length, author, published }, "byline resolved");
    return { ...(author?.trim() && { author }), ...(published?.trim() && { published }) };
}
