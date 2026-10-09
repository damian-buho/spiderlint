// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { load, type CheerioAPI } from "cheerio";
import type { Facts, SiteFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule, resolve } from "../rules/builtin.ts";
import { said } from "../rules/message.ts";
import type { Finding, Make } from "../rules/types.ts";
import { SUPERSEDED } from "./schema-registry.ts";
import { definePlugin } from "./types.ts";

type Node = Record<string, unknown>;

// A parsed element, as cheerio hands it out.
type Element = Exclude<Parameters<typeof load>[0], string | Buffer | unknown[]>;

const ID = "structureddata";

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

// Types describing the page they sit on, whose `name` should echo its title and whose `url` its canonical.
const PAGES = new Set(["WebPage", "AboutPage", "CheckoutPage", "CollectionPage", "ContactPage", "FAQPage", "ItemPage", "MedicalWebPage", "ProfilePage", "QAPage", "SearchResultsPage"]);

// Article types, whose `headline` stands in for `name` and which carry a publication date.
const ARTICLES = new Set(["Article", "AdvertiserContentArticle", "AnalysisNewsArticle", "BackgroundNewsArticle", "BlogPosting", "LiveBlogPosting", "NewsArticle", "OpinionNewsArticle", "Report", "ReportageNewsArticle", "ReviewNewsArticle", "SatiricalArticle", "ScholarlyArticle", "SocialMediaPosting", "TechArticle"]);

// Per-page types never expected to share one identity across the site.
const PER_PAGE = new Set([...PAGES, ...ARTICLES, "BreadcrumbList", "ListItem"]);

// ISO 8601 date or date-time, as schema.org `Date` and `DateTime` accept it.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// Date-valued properties outside the `date*` and `*Date` names.
const DATES = new Set(["uploadDate", "validFrom", "validThrough", "expires", "priceValidUntil", "availabilityStarts", "availabilityEnds"]);

export interface StructuredDataFacts {
    microdata: Node[];
    rdfa: Node[];
}

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value);

// A vocabulary term’s bare name: `https://schema.org/Person` and `schema:Person` are `Person`.
const bare = (term: string) => term.replace(/^.*[/#:]/, "");

// An `@id` made absolute against the page, fragment kept; a blank node stays as written.
const absolute = (id: string, base: string) => (!id.startsWith("_:") && URL.canParse(id, base) ? new URL(id, base).href : id);

// The bare terms of a space-separated attribute.
const terms = (attribute: string | undefined) =>
    (attribute ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((term) => bare(term));

// How one syntax marks an item, its properties, identity and types.
interface Syntax {
    scope: string;
    prop: string;
    id: string[];
    type: string;
    // Selectors for an item, a property, and a top-level item.
    items: string;
    props: string;
    tops: string;
}

const MICRODATA: Syntax = { scope: "itemscope", prop: "itemprop", id: ["itemid"], type: "itemtype", items: "[itemscope]", props: "[itemprop]", tops: "[itemscope]:not([itemprop])" };
const RDFA: Syntax = { scope: "typeof", prop: "property", id: ["resource", "about"], type: "typeof", items: "[typeof]", props: "[property]", tops: "[typeof]:not([property])" };

// The value a property element carries: its `content`, a URL attribute resolved, a machine value, or its text.
function valueOf($: CheerioAPI, element: Element, base: string): string {
    const node = $(element);
    const url = node.attr("href") ?? node.attr("src") ?? node.attr("data");
    return node.attr("content") ?? (url === undefined ? undefined : resolve(url, base)) ?? node.attr("value") ?? node.attr("datetime") ?? node.text().replaceAll(/\s+/g, " ").trim();
}

// One item as a JSON-LD-shaped node: `@type`, `@id` and each property, nested items as nodes.
function itemOf($: CheerioAPI, element: Element, syntax: Syntax, base: string): Node {
    const node: Node = {};
    const types = terms($(element).attr(syntax.type));
    if (types.length > 0) node["@type"] = types;
    const id = syntax.id.map((key) => $(element).attr(key)).find((value) => value !== undefined);
    if (id !== undefined) node["@id"] = absolute(id, base);
    const owned = $(element)
        .find(syntax.props)
        .filter((_, property) => $(property).parent().closest(syntax.items).get(0) === element);
    for (const property of owned.get()) {
        const value = $(property).attr(syntax.scope) === undefined ? valueOf($, property, base) : itemOf($, property, syntax, base);
        const names = terms($(property).attr(syntax.prop));
        for (const name of names) node[name] = node[name] === undefined ? value : [node[name], value].flat();
    }
    return node;
}

// Top-level Microdata and RDFa items; a page without either marker skips the parse.
async function extract(page: Facts, body: string): Promise<StructuredDataFacts | undefined> {
    if (!page.html || !/\bitemscope\b|\btypeof\s*=/i.test(body)) return;
    const $ = load(body);
    const top = (syntax: Syntax) =>
        $(syntax.tops)
            .get()
            .map((element) => itemOf($, element, syntax, page.url.href));
    const facts = { microdata: top(MICRODATA), rdfa: top(RDFA) };
    log.debug({ url: page.url.href, microdata: facts.microdata.length, rdfa: facts.rdfa.length }, "structured data read");
    return facts;
}

// The top-level nodes of every syntax: each JSON-LD object, array entry and `@graph` member, then each Microdata and RDFa item.
function nodesOf(page: Facts): Node[] {
    const blocks = (page.html?.jsonld ?? []).flatMap((block) => (Array.isArray(block) ? block : [block])).filter((block) => isNode(block) && !("@error" in block));
    const markup = page[ID] as StructuredDataFacts | undefined;
    return [...blocks.flatMap((block) => (Array.isArray(block["@graph"]) ? block["@graph"].filter(isNode) : [block])), ...(markup?.microdata ?? []), ...(markup?.rdfa ?? [])];
}

// Every node at any depth, top-level ones first.
function* everyNode(value: unknown): Generator<Node> {
    if (Array.isArray(value)) for (const entry of value) yield* everyNode(entry);
    if (!isNode(value)) return;
    yield value;
    for (const [key, child] of Object.entries(value)) if (key !== "@context") yield* everyNode(child);
}

// A node’s types, a bare name for a schema.org IRI.
function typesOf(node: Node): string[] {
    const raw = node["@type"];
    return (Array.isArray(raw) ? raw : [raw]).filter((type): type is string => typeof type === "string").map((type) => type.replace(/^https?:\/\/schema\.org\//, ""));
}

// Present and not empty.
const isSet = (value: unknown) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);

// Every node of the page at any depth.
const allNodes = (page: Facts) => nodesOf(page).flatMap((top) => everyNode(top).toArray());

// A node that says something besides its identity.
const isDefinition = (node: Node) => typeof node["@id"] === "string" && Object.keys(node).some((key) => key !== "@id" && key !== "@context");

const parse = pageRule(
    "structured-data/parse",
    ["html.jsonld"],
    (page) => {
        if (!page.html) return;
        const errors = page.html.jsonld.filter((block): block is { "@error": string } => isNode(block) && typeof block["@error"] === "string").map((block) => block["@error"]);
        return errors.length === 0 ? [] : [{ ...said("JSON-LD blocks do not parse"), data: { [page.url.href]: { blocks: errors.length } }, locations: errors, value: errors }];
    },
    { docs: "https://json-ld.org/spec/latest/json-ld/", fix: "Serialise the JSON-LD with a JSON encoder instead of a text template, so quotes and newlines in values are escaped." },
);

const required = pageRule(
    "structured-data/required",
    ["html.jsonld", ID],
    (page) => {
        if (!page.html) return;
        const locations = nodesOf(page).flatMap((node) =>
            typesOf(node).flatMap((type) => {
                const missing = (REQUIRED[type] ?? []).filter((property) => !isSet(node[property]));
                return missing.length === 0 ? [] : [`${type} without ${missing.join(", ")}`];
            }),
        );
        return locations.length === 0 ? [] : [{ ...said("structured data nodes lack properties their rich result requires"), data: { [page.url.href]: { nodes: locations.length } }, value: locations, locations }];
    },
    { docs: GALLERY, fix: "Add the missing properties to each named node, or drop a type the page does not really describe." },
);

// The URL a `ListItem.item` names: a string, or a node’s `@id` or `url`.
function itemUrl(item: unknown): string | undefined {
    if (typeof item === "string") return item;
    if (!isNode(item)) return undefined;
    const url = item["@id"] ?? item.url;
    return typeof url === "string" ? url : undefined;
}

// Lower-cased with whitespace collapsed, for a containment test between a title and a name.
const folded = (text: string) => text.toLowerCase().replaceAll(/\s+/g, " ").trim();

// Page and article nodes whose `url` or `mainEntityOfPage` is not the canonical, or whose name appears in neither `<title>` nor `og:title`.
const consistent = pageRule(
    "structured-data/consistent",
    ["html.jsonld", ID, "html.canonical", "html.title", "html.property"],
    (page) => {
        if (!page.html) return;
        const html = page.html;
        const canonical = resolve(html.canonical ?? page.url.twin ?? page.url.href, page.url.href);
        const titles = [html.title, html.property["og:title"]].filter((title): title is string => title !== undefined).map((title) => folded(title));
        const locations = nodesOf(page).flatMap((node) => {
            const type = typesOf(node).find((name) => PAGES.has(name) || ARTICLES.has(name));
            if (!type) return [];
            const urls = [node.url, node.mainEntityOfPage]
                .map((value) => itemUrl(value))
                .filter((url): url is string => url !== undefined)
                .map((url) => resolve(url, page.url.href));
            const name = [node.headline, node.name].find((value): value is string => typeof value === "string");
            log.debug({ url: page.url.href, type, canonical, urls, name }, "page entity compared");
            return [
                ...urls.filter((url) => url !== canonical).map((url) => `${type} names ${url}, the canonical is ${canonical}`),
                ...(name !== undefined && titles.length > 0 && titles.every((title) => !title.includes(folded(name)) && !folded(name).includes(title)) ? [`${type} “${name}” appears in neither the title nor og:title`] : []),
            ];
        });
        return locations.length === 0 ? [] : [{ ...said("structured data claims disagree with the page’s own tags"), data: { [page.url.href]: { claims: locations.length } }, value: locations, locations }];
    },
    { docs: "https://developers.google.com/search/docs/appearance/structured-data/sd-policies", fix: "Point `url` and `mainEntityOfPage` at the canonical URL, and use the page title as the entity’s `name` or `headline`." },
);

// The document an `@id` points into: everything before its fragment.
const documentOf = (id: string) => id.split("#", 1)[0] ?? id;

// Each bare `{ "@id" }` reference to a blank node or fragment that the crawled page it points into never defines, once per `@id`, with the pages naming it.
const references: Make = (severity) => ({
    meta: { id: "structured-data/references", severity, scope: "site", facts: ["html.jsonld", ID], docs: "https://www.w3.org/TR/json-ld11/#node-identifiers", fix: "Define each referenced `@id` on the page it points into, or on the referring page itself; a reference into a page that never defines it names nothing." },
    check(pages: Facts[]) {
        const defined = new Map<string, Set<string>>();
        for (const page of pages) {
            const ids = new Set(
                allNodes(page)
                    .filter((node) => isDefinition(node))
                    .map((node) => absolute(String(node["@id"]), page.url.href)),
            );
            for (const href of [page.url.href, page.url.twin]) if (href) defined.set(resolve(href, href), ids);
        }
        const naming = new Map<string, string[]>();
        for (const page of pages) {
            const own = defined.get(resolve(page.url.href, page.url.href)) ?? new Set<string>();
            const ids = new Set(
                allNodes(page)
                    .filter((node) => typeof node["@id"] === "string" && !isDefinition(node))
                    .map((node) => absolute(String(node["@id"]), page.url.href)),
            );
            for (const id of ids) {
                const target = id.startsWith("_:") ? own : id.includes("#") ? defined.get(documentOf(id)) : undefined;
                const isDangling = target !== undefined && !target.has(id) && !own.has(id);
                log.debug({ rule: "structured-data/references", url: page.url.href, id, crawled: target !== undefined, isDangling }, "reference judged");
                if (isDangling) naming.set(id, [...(naming.get(id) ?? []), page.url.href]);
            }
        }
        return naming
            .entries()
            .map(([id, urls]): Finding => ({
                rule: "structured-data/references",
                severity,
                scope: "site",
                url: id,
                ...(id.startsWith("_:") ? said("a reference names a node its own page never defines; named by these pages") : { ...said("a reference names a node its document never defines; named by these pages"), data: { [id]: { document: documentOf(id) } } }),
                value: id,
                urls,
            }))
            .toArray();
    },
});

// Absolute URLs the page’s breadcrumb lists name.
function crumbsOf(page: Facts): string[] {
    const lists = nodesOf(page).filter((node) => typesOf(node).includes("BreadcrumbList"));
    const items = lists.flatMap((list) => [list.itemListElement].flat().filter(isNode));
    return [...new Set(items.flatMap((item) => itemUrl(item.item) ?? []).map((url) => resolve(url, page.url.href)))];
}

// Every breadcrumb target the crawl found answering outside 2xx or redirecting, once per target, with the pages naming it.
const breadcrumbs: Make = (severity) => ({
    meta: { id: "structured-data/breadcrumbs", severity, scope: "site", facts: ["html.jsonld", ID, "http.status", "site.redirects"], docs: "https://developers.google.com/search/docs/appearance/structured-data/breadcrumb", fix: "Point each breadcrumb `item` at the final URL of a page that answers 200." },
    check(pages: Facts[], _group?: string, site?: SiteFacts) {
        const status = new Map(pages.map((page) => [page.url.href, page.http.status]));
        const redirects = site?.redirects ?? {};
        const naming = new Map<string, string[]>();
        for (const page of pages) for (const url of crumbsOf(page)) naming.set(url, [...(naming.get(url) ?? []), page.url.href]);
        const findings: Finding[] = [];
        for (const [url, urls] of naming) {
            const [answer, landing] = [status.get(url), redirects[url]];
            log.debug({ rule: "structured-data/breadcrumbs", url, status: answer, landing, pages: urls.length }, "breadcrumb judged");
            const verdict = landing ? { ...said("the breadcrumb item redirects; named by these pages"), data: { [url]: { landing } } } : answer !== undefined && (answer < 200 || answer > 299) ? said("the breadcrumb item answers {status}; named by these pages", { status: String(answer) }) : undefined;
            if (verdict) findings.push({ rule: "structured-data/breadcrumbs", severity, scope: "site", url, ...verdict, value: landing ?? answer, urls });
        }
        return findings;
    },
});

// Pages per value per key, filled one sighting at a time.
type Sightings = Map<string, Map<string, Set<string>>>;

// Records that `page` shows `value` for `key`.
function sight(sightings: Sightings, key: string, value: string, page: string) {
    const values = sightings.get(key) ?? new Map<string, Set<string>>();
    values.set(value, (values.get(value) ?? new Set<string>()).add(page));
    sightings.set(key, values);
}

// One site finding for a key seen with more than one value, each value located with its page count.
function conflict(url: string, values: Map<string, Set<string>>, sentence: ReturnType<typeof said>, severity: Finding["severity"]): Finding {
    const locations = values
        .entries()
        .map(([value, urls]) => `${value} on ${urls.size} page${urls.size === 1 ? "" : "s"}`)
        .toArray();
    return { rule: "structured-data/entities", severity, scope: "site", url, ...sentence, value: values.keys().toArray(), locations, urls: [...new Set(values.values().flatMap((urls) => urls.values()))] };
}

// One `@id` typed differently on different pages, and one named site-wide entity carried under several `@id`s.
const entities: Make = (severity) => ({
    meta: { id: "structured-data/entities", severity, scope: "site", facts: ["html.jsonld", ID], docs: "https://www.w3.org/TR/json-ld11/#node-identifiers", fix: "Give each real-world entity one absolute `@id` and the same `@type` on every page that describes it." },
    check(pages: Facts[]) {
        const typings: Sightings = new Map();
        const identities: Sightings = new Map();
        for (const page of pages) {
            const definitions = allNodes(page).filter((node) => isDefinition(node) && typesOf(node).length > 0);
            for (const node of definitions) {
                const [id, types] = [absolute(String(node["@id"]), page.url.href), typesOf(node).toSorted((a, b) => a.localeCompare(b))];
                sight(typings, id, types.join(", "), page.url.href);
                const isShared = typeof node.name === "string" && types.every((type) => !PER_PAGE.has(type));
                if (isShared) sight(identities, `${types.join(", ")} “${String(node.name)}”`, id, page.url.href);
            }
        }
        const findings: Finding[] = [];
        for (const [id, values] of typings) {
            log.debug({ rule: "structured-data/entities", id, typings: values.size }, "identity typing judged");
            if (values.size > 1) findings.push(conflict(id, values, said("one @id is typed {count} ways across the site", { count: values.size }), severity));
        }
        for (const [entity, values] of identities) {
            log.debug({ rule: "structured-data/entities", entity, ids: values.size }, "entity identity judged");
            if (values.size > 1)
                findings.push(
                    conflict(
                        values
                            .keys()
                            .toArray()
                            .toSorted((a, b) => a.localeCompare(b))[0] ?? entity,
                        values,
                        said("{entity} is carried under {count} different @ids", { entity, count: values.size }),
                        severity,
                    ),
                );
        }
        return findings;
    },
});

// The term schema.org supersedes `term` with, if any.
const successor = (term: string): string | undefined => (Object.hasOwn(SUPERSEDED, term) ? SUPERSEDED[term] : undefined);

// Types, properties and schema.org enumeration values that schema.org marks `supersededBy`.
const deprecated = pageRule(
    "structured-data/deprecated",
    ["html.jsonld", ID],
    (page) => {
        if (!page.html) return;
        const locations = new Set<string>();
        const nodes = allNodes(page);
        for (const node of nodes) {
            for (const type of typesOf(node)) if (successor(type)) locations.add(`type ${type} → ${successor(type)}`);
            for (const [key, value] of Object.entries(node)) {
                if (!key.startsWith("@") && successor(key)) locations.add(`property ${key} → ${successor(key)}`);
                const iris = [value].flat().filter((term): term is string => typeof term === "string" && /^https?:\/\/schema\.org\/\w+$/.test(term));
                for (const iri of iris) if (successor(bare(iri))) locations.add(`value ${bare(iri)} → ${successor(bare(iri))}`);
            }
        }
        log.debug({ url: page.url.href, superseded: locations.size }, "vocabulary judged");
        return locations.size === 0 ? [] : [{ ...said("schema.org terms are superseded"), data: { [page.url.href]: { terms: locations.size } }, value: [...locations], locations: [...locations] }];
    },
    { docs: "https://schema.org/docs/attic.home.html", fix: "Rename each term to the one schema.org supersedes it with." },
);

// A date-valued property by name.
const isDateProperty = (key: string) => key.startsWith("date") || key.endsWith("Date") || DATES.has(key);

// Milliseconds since the epoch, NaN for anything but a parsable string.
const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);

// Dates that are not ISO 8601, a modification before publication, and a publication date disagreeing with `article:published_time`.
const dates = pageRule(
    "structured-data/dates",
    ["html.jsonld", ID, "html.property"],
    (page) => {
        if (!page.html) return;
        const meta = page.html.property;
        const locations = allNodes(page).flatMap((node) => {
            const type = typesOf(node)[0] ?? "node";
            const invalid = Object.entries(node)
                .filter(([key, value]) => isDateProperty(key) && typeof value === "string" && (!ISO_DATE.test(value.trim()) || Number.isNaN(Date.parse(value))))
                .map(([key, value]) => `${type} ${key} “${String(value)}” is not ISO 8601`);
            const [published, modified, shown] = [time(node.datePublished), time(node.dateModified), time(meta["article:published_time"])];
            return [
                ...invalid,
                ...(published > modified ? [`${type} dateModified ${String(node.dateModified)} is before datePublished ${String(node.datePublished)}`] : []),
                ...(published !== shown && !Number.isNaN(published) && !Number.isNaN(shown) ? [`${type} datePublished ${String(node.datePublished)} disagrees with article:published_time ${meta["article:published_time"]}`] : []),
            ];
        });
        log.debug({ url: page.url.href, invalid: locations.length }, "dates judged");
        return locations.length === 0 ? [] : [{ ...said("structured data dates are malformed or contradictory"), data: { [page.url.href]: { dates: locations.length } }, value: locations, locations }];
    },
    { docs: "https://developers.google.com/search/docs/appearance/structured-data/article", fix: "Write each date as ISO 8601 with a time zone, from the same source that fills `article:published_time`." },
);

export default definePlugin({
    name: "structured-data",
    extractors: [{ id: ID, extract }],
    rules: {
        "structured-data/parse": parse,
        "structured-data/required": required,
        "structured-data/breadcrumbs": breadcrumbs,
        "structured-data/consistent": consistent,
        "structured-data/references": references,
        "structured-data/entities": entities,
        "structured-data/deprecated": deprecated,
        "structured-data/dates": dates,
    },
    presets: {
        "structured-data": {
            description: "JSON-LD, Microdata and RDFa that parse, carry what their rich result requires, agree with the page and each other, use current schema.org terms and valid dates, and whose breadcrumbs lead to live pages",
            rules: {
                "structured-data/parse": { severity: "error", score: 7.8 },
                "structured-data/required": { severity: "warning", score: 5.8 },
                "structured-data/breadcrumbs": { severity: "warning", score: 5.2 },
                "structured-data/consistent": { severity: "warning", score: 5.4 },
                "structured-data/references": { severity: "warning", score: 4.8 },
                "structured-data/entities": { severity: "warning", score: 5 },
                "structured-data/deprecated": { severity: "warning", score: 4 },
                "structured-data/dates": { severity: "warning", score: 4.6 },
            },
        },
    },
});
