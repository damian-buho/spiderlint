// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { reason } from "../crawl/fetch.ts";
import { RobotsDisallowed, type Probe, type ProbeInit } from "../crawl/probe.ts";
import { isJudged } from "../crawl/links.ts";
import type { Facts, LinkFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { isIP } from "node:net";
import { marked, type TokensList } from "marked";
import { checkCarbonTxt } from "./carbon-txt.ts";
import { isSpecialUse, texts } from "./dns.ts";
import { mediaType } from "./origin.ts";
import { definePlugin, type Extractor, type PageContext, type SiteContext, type SiteExtractor } from "./types.ts";
import { REGISTERED } from "./well-known-registry.ts";

// What a format check found: its defects, and the few values worth keeping as facts.
interface Verdict {
    errors: string[];
    fields?: Record<string, unknown>;
    "days-left"?: number;
    expired?: string[];
    "age-days"?: number;
}

// The probed file a check reads.
interface File {
    url: string;
    origin: string;
    answer: Probe;
}

type Check = (text: string, file: File, context: SiteContext) => Verdict | Promise<Verdict>;

// One file: its fact key, the paths tried in order, its check, and the rule judging it.
interface Spec {
    key: string;
    paths: string[];
    check?: Check;
    // An HTML page is the file itself, and a redirect off the host counts as present.
    html?: true;
    rule?: { id: string; docs: string; score?: number };
}

const DAY_MS = 86_400_000;

// Links one file may send out before the rest are only counted.
const MAX_LINKS = 200;

interface WellKnownSettings {
    "max-links": number;
}

// Parses a JSON body; a parse failure is `undefined` with its defect recorded.
function parse(text: string, errors: string[]): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        errors.push(`not JSON: ${reason(error)}`);
        return undefined;
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Records each member `data` lacks, prefixed with where it sits.
function need(data: Record<string, unknown>, members: string[], errors: string[], where = ""): void {
    for (const member of members) if (data[member] === undefined) errors.push(`${where}${member} missing`);
}

// Records each member an array’s items lack, naming the item by position; an absent array was reported by `need`.
function each(value: unknown, name: string, members: string[], errors: string[]): Record<string, unknown>[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        errors.push(`${name} is not an array`);
        return [];
    }
    const items: Record<string, unknown>[] = [];
    for (const [index, item] of value.entries()) {
        if (!isObject(item)) {
            errors.push(`${name}[${index}] is not an object`);
            continue;
        }
        need(item, members, errors, `${name}[${index}].`);
        items.push(item);
    }
    return items;
}

// Records a media type other than the expected ones.
function served(answer: Probe, types: string[], errors: string[]): void {
    const type = mediaType(answer);
    if (!types.includes(type)) errors.push(`served as ${type || "no type"}, not ${types.join(" or ")}`);
}

// Records a member naming another origin than the probed one.
function sameOrigin(value: unknown, name: string, accepted: string[], errors: string[]): void {
    if (value !== undefined && !accepted.includes(String(value))) errors.push(`${name} ${String(value)} is not ${accepted[0]}`);
}

// A check of a JSON body of one shape; any other shape is its one defect.
function json(shape: "object", inspect: (data: Record<string, unknown>, errors: string[], file: File, context: SiteContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>): Check;
function json(shape: "array", inspect: (data: unknown[], errors: string[], file: File, context: SiteContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>): Check;
function json(shape: "object" | "array", inspect: (data: never, errors: string[], file: File, context: SiteContext) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>): Check {
    return async (text, file, context) => {
        const errors: string[] = [];
        const data = parse(text, errors);
        const isShape = shape === "array" ? Array.isArray(data) : isObject(data);
        if (data !== undefined && !isShape) errors.push(`not a JSON ${shape}`);
        if (!isShape) return { errors };
        const fields = await inspect(data as never, errors, file, context);
        return { errors, ...(fields && { fields }) };
    };
}

// A PGP cleartext signature’s signed text.
const SIGNED = /^-----BEGIN PGP SIGNED MESSAGE-----\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n-----BEGIN PGP SIGNATURE-----/;

// RFC 9116: fields parsed, Contact and one Expires present, Canonical naming this URL, served as text/plain.
const securityTxt: Check = (text, { url, answer }) => {
    const errors: string[] = [];
    served(answer, ["text/plain"], errors);
    const signed = SIGNED.exec(text)?.[1]?.replaceAll(/^- /gm, "");
    const fields: Record<string, string[]> = {};
    const lines = (signed ?? text).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
        if (line.trim() === "" || line.startsWith("#")) continue;
        const match = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
        if (match) (fields[(match[1] as string).toLowerCase()] ??= []).push(match[2] as string);
        else errors.push(`line ${index + 1} is not a field`);
    }
    if (!fields.contact) errors.push("Contact missing");
    const contacts = fields.contact ?? [];
    for (const contact of contacts) if (!URL.canParse(contact)) errors.push(`Contact ${contact} is not a URI`);
    if (fields.expires?.length !== 1) errors.push(fields.expires ? "Expires repeated" : "Expires missing");
    if ((fields["preferred-languages"]?.length ?? 0) > 1) errors.push("Preferred-Languages repeated");
    if (fields.canonical && !fields.canonical.includes(url)) errors.push(`Canonical does not name ${url}`);
    const expires = Date.parse(fields.expires?.[0] ?? "");
    if (fields.expires && Number.isNaN(expires)) errors.push(`Expires ${fields.expires[0] as string} is not a date`);
    return { errors, fields, ...(!Number.isNaN(expires) && { "days-left": Math.floor((expires - Date.now()) / DAY_MS) }) };
};

// The first nodeinfo document on the host, and the schema versions its links name.
const nodeinfo = json("object", async (data, errors, { url }, context) => {
    const links = each(data.links, "links", ["rel", "href"], errors);
    if (data.links === undefined) errors.push("links missing");
    const versions = links.map((link) => /\/schema\/([\d.]+)$/.exec(String(link.rel))?.[1]).filter((version) => version !== undefined);
    const first = links.find((link) => URL.canParse(String(link.href), url) && new URL(String(link.href), url).hostname === new URL(url).hostname);
    if (!first) {
        log.debug({ url, links: links.length }, "nodeinfo links none on this host");
        return { versions };
    }
    const answer = await context.fetch(new URL(String(first.href), url).href, { redirect: "follow" });
    const linked = answer.status === 200 ? parse(answer.body, errors) : undefined;
    if (answer.status !== 200) errors.push(`${answer.url} answers ${answer.status}`);
    else if (!isObject(linked) || typeof linked.version !== "string") errors.push(`${answer.url} names no version`);
    return { versions, ...(isObject(linked) && { version: linked.version }) };
});

// Defects of links that do not answer 2xx, crawled pages judged from the store and at most `max-links` others through the `probes` bucket, the rest counted as `unprobed`.
async function linkErrors(links: string[], context: SiteContext, kind: string): Promise<{ errors: string[]; probed: number; unprobed: number }> {
    const errors: string[] = [];
    const statuses = new Map(context.pages.map((page) => [page.url.href, page.http.status]));
    const max = (context.settings as WellKnownSettings | undefined)?.["max-links"] ?? MAX_LINKS;
    let probed = 0;
    let unprobed = 0;
    const distinct = new Set(links);
    for (const link of distinct) {
        const isProbed = !statuses.has(link) && /^https?:$/.test(new URL(link).protocol);
        if (isProbed && probed >= max) {
            unprobed += 1;
            log.debug({ link, kind, max }, "file link left unprobed");
            continue;
        }
        const answer: Omit<LinkFacts, "status"> & { status?: number } = isProbed ? await context.link(link) : { status: statuses.get(link) };
        probed += isProbed ? 1 : 0;
        log.debug({ link, kind, status: answer.status, isProbed }, "file link judged");
        if (answer.status === undefined || !isJudged({ ...answer, status: answer.status })) continue;
        if (answer.status === 0) errors.push(`${link} is unreachable: ${answer.error ?? "no answer"}`);
        else if (answer.status < 200 || answer.status > 299) errors.push(`${link} answers ${answer.status}`);
    }
    return { errors, probed, unprobed };
}

// Every distinct link of a Markdown document, inline, reference, autolink and unused definition alike, resolved against `url`.
function markdownLinks(tokens: TokensList, url: string): string[] {
    const hrefs = Object.values(tokens.links).map((link) => link.href);
    marked.walkTokens(tokens, (token) => {
        if (token.type === "link") hrefs.push(token.href);
    });
    return [...new Set(hrefs.flatMap((href) => (URL.canParse(href, url) ? [new URL(href, url).href] : [])))];
}

// llmstxt.org: not empty, one H1 first, served as one of `types` when given, and links that answer 2xx, crawled or probed through the `probes` bucket.
function llmsCheck(kind: string, types?: string[]): Check {
    return async (text, { url, answer }, context) => {
        const errors: string[] = [];
        if (types) served(answer, types, errors);
        if (text.trim() === "") errors.push("empty");
        const tokens = marked.lexer(text);
        const headings = tokens.filter((token) => token.type === "heading" && token.depth === 1);
        if (headings.length !== 1) errors.push(`${headings.length} H1 headings, not 1`);
        if (headings[0] === undefined || tokens.find((token) => token.type !== "space") !== headings[0]) errors.push("does not open with its H1");
        const links = markdownLinks(tokens, url);
        const judged = await linkErrors(links, context, kind);
        log.debug({ url, kind, headings: headings.length, links: links.length, probed: judged.probed, unprobed: judged.unprobed }, "llms file checked");
        return { errors: [...errors, ...judged.errors], fields: { title: (headings[0] as { text?: string } | undefined)?.text, links: links.length, probed: judged.probed, unprobed: judged.unprobed } };
    };
}

// carbontxt.org syntax, and disclosure URLs that answer 2xx.
const carbonTxtCheck: Check = async (text, _file, context) => {
    const { links, ...verdict } = checkCarbonTxt(text);
    const judged = await linkErrors(links, context, "carbon.txt");
    return { ...verdict, errors: [...verdict.errors, ...judged.errors] };
};

// Files under the RFC 8615 prefix, with the rule judging each when present.
const WELL_KNOWN: Spec[] = [
    { key: "security-txt", paths: ["/.well-known/security.txt"], check: securityTxt },
    { key: "change-password", paths: ["/.well-known/change-password"], html: true },
    {
        key: "gpc",
        paths: ["/.well-known/gpc.json"],
        rule: { id: "gpc", score: 4.4, docs: "https://www.w3.org/TR/gpc/#gpc-support-resource" },
        check: json("object", (data, errors) => {
            if (typeof data.gpc !== "boolean") errors.push("gpc is not a boolean");
            if (data.lastUpdate !== undefined && Number.isNaN(Date.parse(String(data.lastUpdate)))) errors.push("lastUpdate is not a date");
            return { gpc: data.gpc };
        }),
    },
    {
        key: "api-catalog",
        paths: ["/.well-known/api-catalog"],
        rule: { id: "api-catalog", score: 4.6, docs: "https://www.rfc-editor.org/rfc/rfc9727#section-4" },
        check: json("object", (data, errors, { answer }) => {
            served(answer, ["application/linkset+json"], errors);
            if (!Array.isArray(data.linkset)) errors.push("linkset is not an array");
        }),
    },
    {
        key: "openid-configuration",
        paths: ["/.well-known/openid-configuration"],
        rule: { id: "openid-configuration", score: 5.6, docs: "https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata" },
        check: json("object", (data, errors, { origin }) => {
            need(data, ["issuer", "authorization_endpoint", "jwks_uri", "response_types_supported", "subject_types_supported", "id_token_signing_alg_values_supported"], errors);
            sameOrigin(data.issuer, "issuer", [origin], errors);
        }),
    },
    {
        key: "oauth-authorization-server",
        paths: ["/.well-known/oauth-authorization-server"],
        rule: { id: "oauth-authorization-server", score: 5.6, docs: "https://www.rfc-editor.org/rfc/rfc8414#section-2" },
        check: json("object", (data, errors, { origin }) => {
            need(data, ["issuer", "response_types_supported"], errors);
            sameOrigin(data.issuer, "issuer", [origin], errors);
        }),
    },
    {
        key: "oauth-protected-resource",
        paths: ["/.well-known/oauth-protected-resource"],
        rule: { id: "oauth-protected-resource", score: 5.4, docs: "https://www.rfc-editor.org/rfc/rfc9728#section-3.3" },
        check: json("object", (data, errors, { origin }) => {
            need(data, ["resource"], errors);
            sameOrigin(data.resource, "resource", [origin, `${origin}/`], errors);
        }),
    },
    {
        key: "webauthn",
        paths: ["/.well-known/webauthn"],
        rule: { id: "webauthn", score: 5.4, docs: "https://www.w3.org/TR/webauthn-3/#sctn-related-origins" },
        check: json("object", (data, errors) => {
            if (!Array.isArray(data.origins)) errors.push("origins is not an array");
            const origins: unknown[] = Array.isArray(data.origins) ? data.origins : [];
            for (const origin of origins) if (typeof origin !== "string" || !URL.canParse(origin) || new URL(origin).origin !== origin || !origin.startsWith("https:")) errors.push(`${String(origin)} is not an https origin`);
        }),
    },
    {
        key: "apple-app-site-association",
        paths: ["/.well-known/apple-app-site-association"],
        rule: { id: "apple-app-site-association", score: 5, docs: "https://developer.apple.com/documentation/xcode/supporting-associated-domains" },
        check: json("object", (_data, errors, { answer }) => {
            served(answer, ["application/json"], errors);
            if (answer.redirects.length > 0) errors.push(`reached through ${answer.redirects.length} redirects`);
        }),
    },
    {
        key: "assetlinks",
        paths: ["/.well-known/assetlinks.json"],
        rule: { id: "assetlinks", score: 5, docs: "https://developers.google.com/digital-asset-links/v1/getting-started" },
        check: json("array", (data, errors) => {
            each(data, "statements", ["relation", "target"], errors);
        }),
    },
    { key: "nodeinfo", paths: ["/.well-known/nodeinfo"], rule: { id: "nodeinfo", score: 3.8, docs: "https://github.com/jhass/nodeinfo/blob/main/PROTOCOL.md" }, check: nodeinfo },
    {
        key: "traffic-advice",
        paths: ["/.well-known/traffic-advice"],
        rule: { id: "traffic-advice", score: 4, docs: "https://github.com/buettner/private-prefetch-proxy/blob/main/traffic-advice.md" },
        check: json("array", (data, errors, { answer }) => {
            served(answer, ["application/trafficadvice+json"], errors);
            for (const [index, advice] of each(data, "advice", ["user_agent"], errors).entries()) {
                const isFraction = typeof advice.fraction === "number" && advice.fraction >= 0 && advice.fraction <= 1;
                if (!isFraction && typeof advice.disallow !== "boolean") errors.push(`advice[${index}] has neither a fraction from 0 to 1 nor disallow`);
            }
        }),
    },
    { key: "webfinger", paths: ["/.well-known/webfinger"] },
    {
        key: "tdmrep",
        paths: ["/.well-known/tdmrep.json"],
        rule: { id: "tdmrep", score: 4.2, docs: "https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240510/#sec-tdm-file-orig" },
        check: json("array", (data, errors) => {
            for (const [index, rule] of each(data, "rules", ["location", "tdm-reservation"], errors).entries()) if (rule["tdm-reservation"] !== undefined && ![0, 1].includes(rule["tdm-reservation"] as number)) errors.push(`rules[${index}].tdm-reservation is not 0 or 1`);
        }),
    },
];

// Files agents read, all drafts or proposals.
const AGENTS: Spec[] = [
    { key: "llms-txt", paths: ["/llms.txt", "/.well-known/llms.txt"], check: llmsCheck("llms.txt") },
    { key: "llms-full-txt", paths: ["/llms-full.txt"], check: llmsCheck("llms-full.txt", ["text/markdown", "text/plain"]) },
    {
        key: "agent-card",
        paths: ["/.well-known/agent-card.json"],
        rule: { id: "agent-card", score: 0.6, docs: "https://specification.website/spec/agent-readiness/a2a-agent-cards/" },
        check: json("object", (data, errors, { answer }) => {
            served(answer, ["application/json"], errors);
            need(data, ["name", "description", "version", "supportedInterfaces", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"], errors);
            each(data.supportedInterfaces, "supportedInterfaces", ["url", "protocolBinding", "protocolVersion"], errors);
            each(data.skills, "skills", ["id", "name", "description", "tags"], errors);
            return { name: data.name, version: data.version };
        }),
    },
    {
        key: "ai-catalog",
        paths: ["/.well-known/ai-catalog.json"],
        rule: { id: "ai-catalog", score: 0.4, docs: "https://specification.website/spec/agent-readiness/agentic-resource-discovery/" },
        check: json("object", (data, errors) => {
            need(data, ["specVersion", "host", "entries"], errors);
            for (const [index, entry] of each(data.entries, "entries", ["identifier", "displayName"], errors).entries()) {
                if (entry.mediaType === undefined && entry.type === undefined) errors.push(`entries[${index}] has neither mediaType nor type`);
                if ((entry.url === undefined) === (entry.data === undefined)) errors.push(`entries[${index}] needs exactly one of url and data`);
            }
            return { specVersion: data.specVersion };
        }),
    },
    {
        key: "mcp-server-card",
        paths: ["/.well-known/mcp/server-card.json"],
        rule: { id: "mcp-server-card", score: 0.6, docs: "https://specification.website/spec/agent-readiness/mcp-and-tool-discovery/" },
        check: json("object", (data) => ({ name: data.name, version: data.version })),
    },
    {
        key: "agent-skills",
        paths: ["/.well-known/agent-skills/index.json"],
        rule: { id: "agent-skills", score: 0.5, docs: "https://specification.website/spec/agent-readiness/agent-skills-discovery/" },
        check: json("object", (data, errors) => {
            need(data, ["$schema", "skills"], errors);
            return { schema: data.$schema, skills: each(data.skills, "skills", ["name", "type", "description", "url", "digest"], errors).length };
        }),
    },
    {
        key: "auth-md",
        paths: ["/auth.md"],
        rule: { id: "auth-md", score: 0.3, docs: "https://workos.com/auth-md" },
        check: (text) => ({ errors: text.trim() ? [] : ["the file is empty"], fields: { bytes: text.length } }),
    },
    {
        key: "okf",
        paths: ["/okf/index.md"],
        rule: { id: "okf", score: 0.3, docs: "https://specification.website/spec/agent-readiness/okf-bundle/" },
        check: (text) => {
            const version = /^---\r?\n(?:.*\r?\n)*?okf_version:\s*["']?([^"'\s]+)/.exec(text)?.[1];
            return { errors: version ? [] : ["no okf_version in the front matter"], fields: { version } };
        },
    },
    {
        key: "schemamap",
        paths: ["/schemamap.xml"],
        rule: { id: "schemamap", score: 0.3, docs: "https://specification.website/spec/agent-readiness/schemamap/" },
        check: (text, { answer }) => {
            const errors: string[] = [];
            served(answer, ["application/xml", "text/xml"], errors);
            if (!/<schemamap[\s>]/.test(text)) errors.push("no <schemamap> root");
            return { errors };
        },
    },
];

// One file’s answer; a 2xx that is not an HTML page, or for an `html` file any 2xx or off-host redirect, is present and checked.
async function probeFile(origin: string, path: string, spec: Spec, context: SiteContext, fetch = context.fetch): Promise<Record<string, unknown>> {
    const url = URL.canParse(path) ? path : `${origin}${path}`;
    let answer: Probe;
    try {
        answer = await fetch(url, { redirect: "follow" });
    } catch (error) {
        if (error instanceof RobotsDisallowed) return { url, disallowed: true };
        log.debug({ url, error: reason(error) }, "well-known file unreachable");
        return { url, present: false, error: reason(error) };
    }
    const contentType = mediaType(answer);
    const isSuccess = answer.status >= 200 && answer.status <= 299;
    const isRedirect = answer.status >= 300 && answer.status <= 399 && typeof answer.headers.location === "string";
    const isPresent = spec.html ? isSuccess || isRedirect : isSuccess && contentType !== "text/html";
    const base = { url, status: answer.status, "content-type": contentType, ...(answer.redirects.length > 0 && { redirects: answer.redirects }), present: isPresent };
    log.debug({ url, status: answer.status, contentType, isPresent }, "well-known file probed");
    if (!isPresent || !spec.check) return isPresent ? { ...base, bytes: Buffer.byteLength(answer.body) } : base;
    const verdict = await spec.check(answer.body, { url: answer.url, origin, answer }, context);
    if (answer.truncated) verdict.errors.push("larger than 1 MB");
    return { ...base, bytes: Buffer.byteLength(answer.body), ...verdict };
}

// The first path of a spec that is present, else the first path’s answer.
async function probeSpec(origin: string, spec: Spec, context: SiteContext): Promise<Record<string, unknown>> {
    let first: Record<string, unknown> | undefined;
    for (const path of spec.paths) {
        const answer = await probeFile(origin, path, spec, context);
        if (answer.present) return answer;
        if (!first || first.disallowed) first = answer;
    }
    return first as Record<string, unknown>;
}

// Every spec’s facts under its key.
async function probeAll(origin: string, specs: Spec[], context: SiteContext): Promise<Record<string, Record<string, unknown>>> {
    return Object.fromEntries(await Promise.all(specs.map(async (spec) => [spec.key, await probeSpec(origin, spec, context)] as const)));
}

// `/.well-known/` suffixes the crawled pages link on this origin that IANA has not registered.
function unregistered(origin: string, context: SiteContext): string[] {
    const hrefs = context.pages.flatMap((page) => [...(page.html?.links.internal ?? []), ...(page.html?.links.external ?? []), ...(page.html?.head.links.map((link) => link.href ?? "") ?? [])]);
    const names = hrefs.flatMap((href) => {
        const url = URL.canParse(href) ? new URL(href) : undefined;
        const [, prefix, name] = url?.pathname.split("/") ?? [];
        return name && prefix === ".well-known" && url?.origin === origin && !REGISTERED.has(name) ? [name] : [];
    });
    return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
}

const wellKnown: SiteExtractor = {
    id: "well-known",
    per: "origin",
    crawled: true,
    async extract(origin, context) {
        const files = await probeAll(origin, WELL_KNOWN, context);
        const required = context.pages.some((page) => page.html?.inputs?.some((input) => input.type === "password"));
        const names = unregistered(origin, context);
        log.debug({ origin, present: Object.keys(files).filter((key) => files[key]?.present), required, unregistered: names }, "well-known files probed");
        return { ...files, "change-password": { ...files["change-password"], required }, unregistered: names };
    },
};

const CARBON_TXT: Spec = { key: "carbon-txt", paths: ["/carbon.txt", "/.well-known/carbon.txt"], check: carbonTxtCheck };

// URLs a host delegates its carbon.txt to: `carbon-txt-location=` TXT records, then the seed page’s `CarbonTxt-Location` header.
async function carbonDelegations(origin: string, context: SiteContext): Promise<["dns" | "header", string][]> {
    const host = new URL(origin).hostname.replaceAll(/^\[|\]$/g, "");
    let records: string[] = [];
    if (isIP(host) === 0 && !isSpecialUse(host)) {
        try {
            records = texts(await context.dns.query(host, "TXT")).flatMap((text) => /^carbon-txt-location=(\S+)$/i.exec(text.trim())?.[1] ?? []);
        } catch (error) {
            log.debug({ host, error: reason(error) }, "carbon.txt DNS delegation unread");
        }
    }
    const seed = context.pages.find((page) => page.crawl["discovered-via"] === "seed") ?? context.pages[0];
    const headers = [seed?.http.headers["carbontxt-location"] ?? []].flat();
    const found = [...records.map((url) => ["dns", url] as const), ...headers.map((url) => ["header", url.trim()] as const)].filter(([, url]) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol));
    log.debug({ origin, dns: records.length, header: headers.length, found: found.length }, "carbon.txt delegations read");
    return found.map(([via, url]) => [via, url]);
}

// carbon.txt at the root, under /.well-known/, then where DNS or the seed page’s header delegates it, the first present one kept.
const carbonTxt: SiteExtractor = {
    id: "carbon-txt",
    per: "origin",
    async extract(origin, context) {
        let first: Record<string, unknown> | undefined;
        const direct: ["root" | "well-known", string][] = [
            ["root", "/carbon.txt"],
            ["well-known", "/.well-known/carbon.txt"],
        ];
        for (const [via, path] of direct) {
            const answer: Record<string, unknown> = { via, ...(await probeFile(origin, path, CARBON_TXT, context)) };
            if (answer.present) return answer;
            first ??= answer;
        }
        const delegations = await carbonDelegations(origin, context);
        for (const [via, url] of delegations) {
            const answer: Record<string, unknown> = { via, ...(await probeFile(origin, url, CARBON_TXT, context, context.delegated)) };
            log.debug({ origin, via, url, present: answer.present }, "carbon.txt delegation probed");
            if (answer.present) return answer;
        }
        return first;
    },
};

const agents: SiteExtractor = {
    id: "agents",
    per: "origin",
    async extract(origin, context) {
        const files = await probeAll(origin, AGENTS, context);
        log.debug({ origin, present: Object.keys(files).filter((key) => files[key]?.present) }, "agent files probed");
        return files;
    },
};

// A page’s Markdown twins: its advertised `text/markdown` alternate, else `<url>.md`, a stripped sibling first for a directory (`/posts.md`, then `/posts/index.html.md`).
function twinsOf(page: Facts): string[] {
    const advertised = page.html?.head.links.find((link) => link.rel?.split(/\s+/).includes("alternate") && link.type === "text/markdown")?.href;
    if (advertised && URL.canParse(advertised, page.url.href)) return [new URL(advertised, page.url.href).href];
    if (!page.url.pathname.endsWith("/")) return [new URL(`${page.url.pathname}.md`, page.url.href).href];
    const stripped = page.url.pathname.replace(/\/+$/, "");
    const sibling = new URL(stripped === "" ? "/index.md" : `${stripped}.md`, page.url.href).href;
    const index = new URL(`${page.url.pathname}index.html.md`, page.url.href).href;
    return sibling === index ? [sibling] : [sibling, index];
}

// One Markdown request’s answer, present when `isAccepted` takes its 2xx media type.
async function markdownAt(url: string, init: ProbeInit, isAccepted: (type: string) => boolean, context: PageContext): Promise<Record<string, unknown>> {
    try {
        const answer = await context.fetch(url, { ...init, redirect: "follow" });
        const contentType = mediaType(answer);
        const isPresent = answer.status >= 200 && answer.status <= 299 && isAccepted(contentType);
        log.debug({ url, accept: init.headers?.accept, status: answer.status, contentType, isPresent }, "markdown source probed");
        return { url, status: answer.status, "content-type": contentType, present: isPresent };
    } catch (error) {
        log.debug({ url, error: reason(error) }, "markdown source unreachable");
        return { url, present: false, error: reason(error) };
    }
}

// The page as Markdown: its `.md` twin, and the page itself asked for `text/markdown`; only while crawling, on a 2xx HTML page.
const markdown: Extractor = {
    id: "markdown",
    cost: "expensive",
    cached: false,
    async extract(page, _body, _live, context) {
        const isPage = page.html !== undefined && page.http.status >= 200 && page.http.status <= 299;
        log.debug({ url: page.url.href, isPage, hasNetwork: context !== undefined }, "markdown source decided");
        if (!context || !isPage) return;
        const candidates = twinsOf(page);
        const [twins, negotiated] = await Promise.all([Promise.all(candidates.map((url) => markdownAt(url, {}, (type) => type !== "text/html", context))), markdownAt(page.url.href, { headers: { accept: "text/markdown" } }, (type) => type === "text/markdown", context)]);
        const twin = twins.find((probe) => probe.present) ?? twins[0];
        if (!twin) return;
        return { present: Boolean(twin.present || negotiated.present), twin, negotiated };
    },
};

// The rule judging each checked spec’s defects while its file is present.
function validity(extractor: string, specs: Spec[], severity: RuleSpec["severity"]): Record<string, RuleSpec> {
    return Object.fromEntries(
        specs.flatMap((spec) => {
            if (!spec.rule) return [];
            const at = `site.origins.*.${extractor}.${spec.key}`;
            return [
                [
                    `well-known/${spec.rule.id}`,
                    {
                        fact: `${at}.errors`,
                        expect: { maxItems: 0 },
                        when: { [`${at}.present`]: true },
                        message: [spec.paths[0], "is malformed: {got}"].join(" "),
                        severity,
                        ...(spec.rule.score !== undefined && { score: spec.rule.score }),
                        docs: spec.rule.docs,
                        fix: `Correct each error the finding lists in ${spec.paths[0]}.`,
                    },
                ],
            ];
        }),
    );
}

const SECURITY: Record<string, RuleSpec> = {
    "well-known/security-txt": {
        fact: "site.origins.*.well-known.security-txt.present",
        expect: { const: true },
        message: "no /.well-known/security.txt tells researchers how to report a vulnerability",
        severity: "warning",
        score: 5.8,
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-3",
        fix: "Publish /.well-known/security.txt with a Contact field and an Expires.",
    },
    "well-known/security-txt-valid": {
        fact: "site.origins.*.well-known.security-txt.errors",
        expect: { maxItems: 0 },
        when: { "site.origins.*.well-known.security-txt.present": true },
        message: "/.well-known/security.txt breaks RFC 9116: {got}",
        severity: "warning",
        score: 5.6,
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5",
        fix: "Rewrite security.txt so each field is on its own line with `Field: value`.",
    },
    "well-known/security-txt-expires": {
        fact: "site.origins.*.well-known.security-txt.days-left",
        expect: { minimum: 0, maximum: 366 },
        when: { "site.origins.*.well-known.security-txt.days-left": { type: "number" } },
        message: "/.well-known/security.txt expires in {got} days, not within the next year",
        severity: "warning",
        score: [
            [-365, 6.2],
            [0, 5.4],
            [366, 3.5],
            [1095, 4.5],
        ],
        docs: "https://www.rfc-editor.org/rfc/rfc9116#section-2.5.5",
        fix: "Set Expires in security.txt to a date less than a year away.",
    },
    "well-known/change-password": {
        fact: "site.origins.*.well-known.change-password.present",
        expect: { const: true },
        when: { "site.origins.*.well-known.change-password.required": true },
        message: "a crawled page asks for a password, but /.well-known/change-password leads nowhere",
        severity: "warning",
        score: 5.4,
        docs: "https://w3c.github.io/webappsec-change-password-url/",
        fix: "Serve a 302 or 303 redirect from /.well-known/change-password to the password-change page.",
    },
};

const WELL_KNOWN_RULES: Record<string, RuleSpec> = {
    ...SECURITY,
    ...validity("well-known", WELL_KNOWN, "warning"),
    "well-known/registered": {
        fact: "site.origins.*.well-known.unregistered",
        expect: { maxItems: 0 },
        message: "the crawl links /.well-known/ suffixes IANA has not registered: {got}",
        severity: "info",
        score: 2.2,
        docs: "https://www.rfc-editor.org/rfc/rfc8615#section-3",
        fix: "Register the suffix with IANA, or remove the link if it is not a standard well-known path.",
    },
};

const AGENT_RULES: Record<string, RuleSpec> = {
    "well-known/llms-txt": {
        fact: "site.origins.*.agents.llms-txt.present",
        expect: { const: true },
        message: "no /llms.txt summarises the site for language models",
        severity: "hint",
        score: 0.7,
        docs: "https://llmstxt.org/",
        fix: "Add /llms.txt with an H1, a one-line description, and links to the site’s resources.",
    },
    "well-known/llms-txt-valid": {
        fact: "site.origins.*.agents.llms-txt.errors",
        expect: { maxItems: 0 },
        when: { "site.origins.*.agents.llms-txt.present": true },
        message: "/llms.txt is malformed: {got}",
        severity: "info",
        score: 2.6,
        docs: "https://llmstxt.org/#format",
        fix: "Rewrite /llms.txt as Markdown that opens with one H1 followed by its sections.",
    },
    "well-known/llms-full-txt": {
        fact: "site.origins.*.agents.llms-full-txt.present",
        expect: { const: true },
        when: { "site.origins.*.agents.llms-txt.present": true },
        message: "/llms.txt has no /llms-full.txt twin carrying the whole content",
        severity: "hint",
        score: 0.6,
        docs: "https://llmstxt.org/",
        fix: "Publish /llms-full.txt beside /llms.txt with the full text of the pages it lists.",
    },
    "well-known/llms-full-txt-valid": {
        fact: "site.origins.*.agents.llms-full-txt.errors",
        expect: { maxItems: 0 },
        when: { "site.origins.*.agents.llms-full-txt.present": true },
        message: "/llms-full.txt is malformed: {got}",
        severity: "info",
        score: 2.4,
        docs: "https://llmstxt.org/#format",
        fix: "Open /llms-full.txt with its one H1, serve it as text/markdown, and repair or drop every link that does not answer 200.",
    },
    ...validity("agents", AGENTS, "hint"),
    "well-known/markdown-source": {
        fact: "markdown.present",
        expect: { const: true },
        when: { "markdown.present": { type: "boolean" } },
        message: "no Markdown source: neither a .md twin nor Accept: text/markdown answers with one",
        severity: "hint",
        score: 0.5,
        docs: "https://llmstxt.org/#proposal",
        fix: "Add an index.md twin beside each page, or answer Accept: text/markdown with Markdown at the same URL.",
    },
};

const CARBON_RULES: Record<string, RuleSpec> = {
    "well-known/carbon-txt": {
        fact: "site.origins.*.carbon-txt.present",
        expect: { const: true },
        message: "no carbon.txt discloses the site’s sustainability documents and providers",
        severity: "info",
        score: 2.4,
        fix: "Publish /carbon.txt naming your sustainability disclosures and upstream providers.",
        docs: "https://carbontxt.org/",
    },
    "well-known/carbon-txt-valid": {
        fact: "site.origins.*.carbon-txt.errors",
        expect: { maxItems: 0 },
        when: { "site.origins.*.carbon-txt.present": true },
        message: "carbon.txt is malformed: {got}",
        severity: "info",
        score: 2.2,
        fix: "Correct carbon.txt against syntax 0.5.",
        docs: "https://carbontxt.org/syntax",
    },
    "well-known/carbon-txt-expired": {
        fact: "site.origins.*.carbon-txt.expired",
        expect: { maxItems: 0 },
        when: { "site.origins.*.carbon-txt.present": true },
        message: "carbon.txt names disclosures past their valid_until: {got}",
        severity: "info",
        score: 2.8,
        fix: "Replace each expired disclosure with its current document and valid_until.",
        docs: "https://carbontxt.org/syntax",
    },
    "well-known/carbon-txt-stale": {
        fact: "site.origins.*.carbon-txt.age-days",
        expect: { maximum: 365 },
        when: { "site.origins.*.carbon-txt.age-days": { type: "number" } },
        message: "carbon.txt was last updated {got} days ago, more than a year",
        severity: "info",
        score: [
            [365, 1.2],
            [1095, 3],
        ],
        fix: "Review carbon.txt and bump last_updated.",
        docs: "https://carbontxt.org/syntax",
    },
};

// RFC 8615 files, the files agents read and carbon.txt, probed once per origin.
export default definePlugin({
    name: "well-known",
    settings: { type: "object", additionalProperties: false, properties: { "max-links": { type: "integer", minimum: 0, default: MAX_LINKS } } },
    extractors: [markdown],
    sites: [wellKnown, agents, carbonTxt],
    presets: {
        "well-known": { description: "Files under /.well-known/: security.txt, change-password, and every other known file that is present", rules: WELL_KNOWN_RULES },
        "well-known:security": { description: "security.txt and the change-password redirect", rules: SECURITY },
        "carbon-txt": { description: "carbon.txt: present, valid, current, and its disclosures reachable", rules: CARBON_RULES },
        agents: { description: "Files agents read: llms.txt, per-page Markdown sources, A2A agent card, MCP server card, Agent Skills, AI catalog, OKF, schemamap", rules: AGENT_RULES },
    },
});
