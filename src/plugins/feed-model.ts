// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { SaxesParser } from "saxes";
import { resolve } from "../rules/builtin.ts";

/* eslint-disable unicorn/prefer-https -- namespace names compare as exact strings, scheme included */
export const NS = {
    atom: "http://www.w3.org/2005/Atom",
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    rss1: "http://purl.org/rss/1.0/",
    content: "http://purl.org/rss/1.0/modules/content/",
    dc: "http://purl.org/dc/elements/1.1/",
    itunes: "http://www.itunes.com/dtds/podcast-1.0.dtd",
    podcast: "https://podcastindex.org/namespace/1.0",
    history: "http://purl.org/syndication/history/1.0",
    xml: "http://www.w3.org/XML/1998/namespace",
} as const;
/* eslint-enable unicorn/prefer-https */

export type Format = "rss" | "atom" | "json";
export type TextType = "text" | "html" | "xhtml";

// One XML element: name, attributes by qualified name, children and its own text.
export interface Node {
    local: string;
    uri: string;
    attributes: Record<string, string>;
    children: Node[];
    text: string;
    // Markup of the element’s content, kept for Atom `xhtml` text constructs only.
    markup?: string;
    // The `xml:base` in effect on this element, resolved; absent when the document declares none.
    base?: string;
}

export interface Dated {
    field: string;
    raw: string;
}

export interface Content {
    field: string;
    type: TextType;
    value: string;
    base?: string;
}

export interface Enclosure {
    url?: string;
    length?: string;
    type?: string;
}

// An RSS item, Atom entry or JSON Feed item, format-independent.
export interface Item {
    position: number;
    id?: string;
    isPermalink: boolean;
    link?: string;
    title?: string;
    titleType: TextType;
    published?: Dated;
    updated?: Dated;
    hasAuthor: boolean;
    emails: Dated[];
    contents: Content[];
    enclosures: Enclosure[];
    unknown: string[];
    missing: string[];
    durations: string[];
}

// A feed’s channel and items, format-independent.
export interface Model {
    format: Format;
    version?: string;
    title?: string;
    link?: string;
    language?: string;
    updated?: Dated;
    ttl?: string;
    self?: string;
    hubs: string[];
    archives: Record<string, string>;
    isComplete: boolean;
    hasAuthor: boolean;
    emails: Dated[];
    unknown: string[];
    missing: string[];
    namespaces: Set<string>;
    itunes: Record<string, string>;
    podcastGuid?: string;
    // The `<podcast:locked>` value, when the channel names one.
    locked?: string;
    items: Item[];
}

// Elements RSS 2.0 defines on a channel and on an item.
const RSS_CHANNEL = new Set(["title", "link", "description", "language", "copyright", "managingEditor", "webMaster", "pubDate", "lastBuildDate", "category", "generator", "docs", "cloud", "ttl", "image", "rating", "textInput", "skipHours", "skipDays", "item"]);
const RSS_ITEM = new Set(["title", "link", "description", "author", "category", "comments", "enclosure", "guid", "pubDate", "source"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// The markup of a parsed element, as an `xhtml` construct’s content is read.
function serialize(node: Node): string {
    const attributes = Object.entries(node.attributes).map(([name, value]) => ` ${name}="${escapeText(value).replaceAll('"', "&quot;")}"`).join("");
    const inner = node.markup ?? "";
    return !inner && VOID.has(node.local) ? `<${node.local}${attributes}/>` : `<${node.local}${attributes}>${inner}</${node.local}>`;
}

// The element tree of an XML document, `xml:base` resolved down it; throws on the first well-formedness error.
export function parseXml(body: string, base: string): { root: Node; stylesheet?: string; namespaces: Set<string> } {
    const parser = new SaxesParser({ xmlns: true });
    const stack: Node[] = [];
    const namespaces = new Set<string>();
    let root: Node | undefined;
    let stylesheet: string | undefined;
    parser.on("processinginstruction", (instruction) => {
        if (!root && instruction.target === "xml-stylesheet") stylesheet ??= /\bhref\s*=\s*["']([^"']*)["']/.exec(instruction.body)?.[1];
    });
    parser.on("opentag", (tag) => {
        const parent = stack.at(-1);
        const attributes = Object.fromEntries(Object.values(tag.attributes).map((attribute) => [attribute.name, attribute.value]));
        const bindings = Object.entries(tag.ns ?? {});
        for (const [prefix, uri] of bindings) if (prefix) namespaces.add(uri);
        const declared = attributes["xml:base"] ? resolve(attributes["xml:base"], parent?.base ?? base) : parent?.base;
        const node: Node = { local: tag.local, uri: tag.uri, attributes, children: [], text: "", ...(declared && { base: declared }) };
        if (parent?.markup !== undefined) node.markup = "";
        if (parent && parent.uri === NS.atom && parent.attributes.type === "xhtml" && ["content", "summary", "title", "subtitle", "rights"].includes(parent.local)) node.markup = "";
        parent?.children.push(node);
        root ??= node;
        stack.push(node);
    });
    const append = (chunk: string) => {
        const node = stack.at(-1);
        if (!node) return;
        node.text += chunk;
        if (node.markup !== undefined) node.markup += escapeText(chunk);
    };
    parser.on("text", append);
    parser.on("cdata", append);
    parser.on("closetag", () => {
        const node = stack.pop();
        const parent = stack.at(-1);
        if (node && parent?.markup !== undefined) parent.markup += serialize(node);
    });
    parser.write(body).close();
    if (!root) throw new Error("document has no root element");
    return { root, ...(stylesheet && { stylesheet }), namespaces };
}

const childrenOf = (node: Node | undefined, local: string, uri = "") => (node?.children ?? []).filter((child) => child.local === local && child.uri === uri);
const childOf = (node: Node | undefined, local: string, uri = "") => childrenOf(node, local, uri)[0];
const textOf = (node: Node | undefined) => node?.text.trim() || undefined;
const typeOf = (node: Node | undefined): TextType => (node?.attributes.type === "html" || node?.attributes.type === "xhtml" ? node.attributes.type : "text");
const dated = (node: Node | undefined, field: string): Dated | undefined => (textOf(node) ? { field, raw: textOf(node) as string } : undefined);
const emailsOf = (node: Node | undefined, names: string[]): Dated[] => names.flatMap((name) => childrenOf(node, name).flatMap((child) => (textOf(child) ? [{ field: name, raw: textOf(child) as string }] : [])));

// Un-namespaced children `known` does not name, once each.
const unknownIn = (node: Node | undefined, known: Set<string>) => [...new Set((node?.children ?? []).filter((child) => child.uri === "" && !known.has(child.local)).map((child) => child.local))];

// Atom links of `node` by relation, the default relation `alternate`, resolved against the element’s base.
function atomLinks(node: Node | undefined, base: string): Record<string, string[]> {
    const links: Record<string, string[]> = {};
    for (const link of childrenOf(node, "link", NS.atom)) {
        const relation = link.attributes.rel ?? "alternate";
        (links[relation] ??= []).push(resolve(link.attributes.href ?? "", link.base ?? base));
    }
    return links;
}

// RFC 5005 archive relations a feed names.
function archivesOf(node: Node | undefined, base: string): Record<string, string> {
    const links = atomLinks(node, base);
    return Object.fromEntries(["current", "prev-archive", "next-archive"].flatMap((relation) => (links[relation]?.[0] ? [[relation, links[relation][0]]] : [])));
}

const itunesOf = (node: Node | undefined) => Object.fromEntries((node?.children ?? []).filter((child) => child.uri === NS.itunes).map((child) => [child.local, child.attributes.href ?? child.attributes.text ?? child.text.trim()]));

// An RSS 2.0 or RSS 1.0 item.
function rssItem(node: Node, position: number, isRdf: boolean): Item {
    const ns = isRdf ? NS.rss1 : "";
    const guid = childOf(node, "guid");
    const id = textOf(guid) ?? node.attributes["rdf:about"];
    const contents: Content[] = [childOf(node, "description", ns), childOf(node, "encoded", NS.content)].flatMap((child) => (child && child.text.trim() ? [{ field: child.uri === NS.content ? "content:encoded" : "description", type: "html" as const, value: child.text, ...(child.base && { base: child.base }) }] : []));
    const title = childOf(node, "title", ns);
    const link = textOf(childOf(node, "link", ns));
    const missing = [...(!title && !childOf(node, "description", ns) ? ["title or description"] : []), ...(isRdf && !link ? ["link"] : [])];
    const enclosures = childrenOf(node, "enclosure").map((child) => ({ url: child.attributes.url, length: child.attributes.length, type: child.attributes.type }));
    return {
        position,
        ...(id && { id }),
        isPermalink: !isRdf && guid !== undefined && guid.attributes.isPermaLink !== "false",
        ...(link && { link }),
        ...(title && { title: title.text.trim() }),
        titleType: "text",
        ...((dated(childOf(node, "pubDate"), "pubDate") ?? dated(childOf(node, "date", NS.dc), "dc:date")) && { published: dated(childOf(node, "pubDate"), "pubDate") ?? dated(childOf(node, "date", NS.dc), "dc:date") }),
        hasAuthor: childOf(node, "author") !== undefined || childOf(node, "creator", NS.dc) !== undefined,
        emails: emailsOf(node, ["author"]),
        contents,
        enclosures,
        unknown: isRdf ? [] : unknownIn(node, RSS_ITEM),
        missing,
        durations: childrenOf(node, "duration", NS.itunes).map((child) => child.text.trim()),
    };
}

// An RSS 2.0, 0.9x or 1.0 document.
function readRss(root: Node, namespaces: Set<string>, base: string): Model {
    const isRdf = root.uri === NS.rdf;
    const ns = isRdf ? NS.rss1 : "";
    const channel = childOf(root, "channel", ns);
    const items = isRdf ? childrenOf(root, "item", NS.rss1) : childrenOf(channel, "item");
    const links = atomLinks(channel, base);
    const missing = [...(channel ? ["title", "link", "description"].filter((name) => !childOf(channel, name, ns)) : ["channel"]), ...(!isRdf && !root.attributes.version ? ["version attribute"] : [])];
    const podcastGuid = textOf(childOf(channel, "guid", NS.podcast));
    const locked = textOf(childOf(channel, "locked", NS.podcast));
    return {
        format: "rss",
        ...(root.attributes.version && { version: root.attributes.version }),
        ...(textOf(childOf(channel, "title", ns)) && { title: textOf(childOf(channel, "title", ns)) }),
        ...(textOf(childOf(channel, "link", ns)) && { link: textOf(childOf(channel, "link", ns)) }),
        ...((textOf(childOf(channel, "language")) ?? textOf(childOf(channel, "language", NS.dc))) && { language: textOf(childOf(channel, "language")) ?? textOf(childOf(channel, "language", NS.dc)) }),
        ...(dated(childOf(channel, "lastBuildDate"), "lastBuildDate") && { updated: dated(childOf(channel, "lastBuildDate"), "lastBuildDate") }),
        ...(textOf(childOf(channel, "ttl")) && { ttl: textOf(childOf(channel, "ttl")) }),
        ...(links.self?.[0] && { self: links.self[0] }),
        hubs: links.hub ?? [],
        archives: archivesOf(channel, base),
        isComplete: childOf(channel, "complete", NS.history) !== undefined,
        hasAuthor: true,
        emails: emailsOf(channel, ["managingEditor", "webMaster"]),
        unknown: isRdf ? [] : unknownIn(channel, RSS_CHANNEL),
        missing,
        namespaces,
        itunes: itunesOf(channel),
        ...(podcastGuid && { podcastGuid }),
        ...(locked !== undefined && { locked }),
        items: items.map((node, index) => rssItem(node, index + 1, isRdf)),
    };
}

// An Atom text construct as content.
function atomContent(node: Node | undefined, field: string): Content[] {
    if (!node || node.attributes.src) return [];
    const type = typeOf(node);
    const value = type === "xhtml" ? (node.children.at(0)?.markup ?? node.markup ?? "") : node.text;
    return value.trim() ? [{ field, type, value, ...(node.base && { base: node.base }) }] : [];
}

// An Atom entry.
function atomEntry(node: Node, position: number, base: string): Item {
    const title = childOf(node, "title", NS.atom);
    const links = atomLinks(node, base);
    const id = textOf(childOf(node, "id", NS.atom));
    const hasAuthor = childOf(node, "author", NS.atom) !== undefined || childOf(childOf(node, "source", NS.atom), "author", NS.atom) !== undefined;
    return {
        position,
        ...(id && { id }),
        isPermalink: false,
        ...(links.alternate?.[0] && { link: links.alternate[0] }),
        ...(title && { title: title.text.trim() }),
        titleType: typeOf(title),
        ...(dated(childOf(node, "published", NS.atom), "published") && { published: dated(childOf(node, "published", NS.atom), "published") }),
        ...(dated(childOf(node, "updated", NS.atom), "updated") && { updated: dated(childOf(node, "updated", NS.atom), "updated") }),
        hasAuthor,
        emails: [],
        contents: [...atomContent(childOf(node, "content", NS.atom), "content"), ...atomContent(childOf(node, "summary", NS.atom), "summary")],
        enclosures: childrenOf(node, "link", NS.atom).filter((link) => link.attributes.rel === "enclosure").map((link) => ({ url: link.attributes.href, length: link.attributes.length, type: link.attributes.type })),
        unknown: [],
        missing: ["id", "title", "updated"].filter((name) => !childOf(node, name, NS.atom)),
        durations: [],
    };
}

// An Atom document.
function readAtom(root: Node, namespaces: Set<string>, base: string): Model {
    const links = atomLinks(root, base);
    const language = root.attributes["xml:lang"];
    return {
        format: "atom",
        ...(textOf(childOf(root, "title", NS.atom)) && { title: textOf(childOf(root, "title", NS.atom)) }),
        ...(links.alternate?.[0] && { link: links.alternate[0] }),
        ...(language && { language }),
        ...(dated(childOf(root, "updated", NS.atom), "updated") && { updated: dated(childOf(root, "updated", NS.atom), "updated") }),
        ...(links.self?.[0] && { self: links.self[0] }),
        hubs: links.hub ?? [],
        archives: archivesOf(root, base),
        isComplete: childOf(root, "complete", NS.history) !== undefined,
        hasAuthor: childOf(root, "author", NS.atom) !== undefined,
        emails: [],
        unknown: [],
        missing: ["id", "title", "updated"].filter((name) => !childOf(root, name, NS.atom)),
        namespaces,
        itunes: {},
        items: childrenOf(root, "entry", NS.atom).map((node, index) => atomEntry(node, index + 1, base)),
    };
}

// The XML model of an RSS or Atom document; throws on the first well-formedness error.
export function readXml(body: string, base: string): Model & { stylesheet?: string } {
    const { root, stylesheet, namespaces } = parseXml(body, base);
    const model = root.uri === NS.atom && root.local === "feed" ? readAtom(root, namespaces, base) : readRss(root, namespaces, base);
    return { ...model, ...(stylesheet && { stylesheet: resolve(stylesheet, base) }) };
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
const hasAuthors = (value: JsonObject) => (Array.isArray(value.authors) && value.authors.length > 0) || isObject(value.author);

// A JSON Feed item.
function jsonItem(value: unknown, position: number): Item {
    const item = isObject(value) ? value : {};
    const id = typeof item.id === "number" ? String(item.id) : string(item.id);
    const contents: Content[] = [
        ...(string(item.content_html) ? [{ field: "content_html", type: "html" as const, value: item.content_html as string }] : []),
        ...(string(item.content_text) ? [{ field: "content_text", type: "text" as const, value: item.content_text as string }] : []),
        ...(string(item.summary) ? [{ field: "summary", type: "text" as const, value: item.summary as string }] : []),
    ];
    return {
        position,
        ...(id && { id }),
        isPermalink: false,
        ...(string(item.url) && { link: item.url as string }),
        ...(string(item.title) && { title: item.title as string }),
        titleType: "text",
        ...(string(item.date_published) && { published: { field: "date_published", raw: item.date_published as string } }),
        ...(string(item.date_modified) && { updated: { field: "date_modified", raw: item.date_modified as string } }),
        hasAuthor: hasAuthors(item),
        emails: [],
        contents,
        enclosures: (Array.isArray(item.attachments) ? item.attachments.filter(isObject) : []).map((attachment) => ({ url: string(attachment.url), length: attachment.size_in_bytes === undefined ? undefined : String(attachment.size_in_bytes), type: string(attachment.mime_type) })),
        unknown: isObject(item.author) ? ["author"] : [],
        missing: [...(id ? [] : ["id"]), ...(contents.some((content) => content.field.startsWith("content_")) ? [] : ["content_html or content_text"])],
        durations: [],
    };
}

// The model of a JSON Feed; undefined when the document is JSON but no JSON Feed.
export function readJson(body: string, base: string): Model | undefined {
    const feed = JSON.parse(body) as unknown;
    if (!isObject(feed) || typeof feed.version !== "string" || !/^https:\/\/jsonfeed\.org\/version\//.test(feed.version)) return undefined;
    const hubs = (Array.isArray(feed.hubs) ? feed.hubs.filter(isObject) : []).flatMap((hub) => (string(hub.url) ? [resolve(hub.url as string, base)] : []));
    return {
        format: "json",
        version: feed.version,
        ...(string(feed.title) && { title: feed.title as string }),
        ...(string(feed.home_page_url) && { link: feed.home_page_url as string }),
        ...(string(feed.language) && { language: feed.language as string }),
        ...(string(feed.feed_url) && { self: resolve(feed.feed_url as string, base) }),
        hubs,
        archives: {},
        isComplete: false,
        hasAuthor: hasAuthors(feed),
        emails: [],
        unknown: isObject(feed.author) ? ["author"] : [],
        missing: [...(string(feed.title) ? [] : ["title"]), ...(Array.isArray(feed.items) ? [] : ["items"])],
        namespaces: new Set(),
        itunes: {},
        items: (Array.isArray(feed.items) ? feed.items : []).map((item, index) => jsonItem(item, index + 1)),
    };
}
