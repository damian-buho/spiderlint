// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, ResourceFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resourceRule } from "../rules/builtin.ts";
import type { Finding, Make } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "manifest";
const FIELDS = ["name", "start_url", "display", "icons"];
const SIZES = ["192x192", "512x512"];
const DOCS = "https://developer.mozilla.org/docs/Web/Progressive_web_apps/Manifest";

export interface ManifestFacts {
    error?: string;
    // Top-level members present and not empty.
    members: string[];
    icons: { sizes: string[]; purpose: string[] }[];
    // `start_url` and `scope` resolved against the manifest, each defaulting as the spec says; `id` as written.
    start?: string;
    scope?: string;
    id?: string;
}

// Space-separated tokens of a manifest string member, lower-cased.
const tokens = (value: unknown) => (typeof value === "string" ? value.toLowerCase().split(/\s+/).filter(Boolean) : []);

// The members and icons of a web app manifest; unparsable JSON is its error.
async function extract(url: string, _contentType: string, body: Uint8Array): Promise<ManifestFacts> {
    let manifest: unknown;
    try {
        manifest = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.debug({ url, error: message }, "manifest unparsable");
        return { error: message, members: [], icons: [] };
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return { error: "not a JSON object", members: [], icons: [] };
    const entries = Object.entries(manifest as Record<string, unknown>);
    const members = entries.filter(([, value]) => value !== "" && value !== null && !(Array.isArray(value) && value.length === 0)).map(([key]) => key);
    const raw = (manifest as { icons?: unknown }).icons;
    const icons = (Array.isArray(raw) ? raw : []).map((icon: { sizes?: unknown; purpose?: unknown }) => ({ sizes: tokens(icon.sizes), purpose: tokens(icon.purpose ?? "any") }));
    const { start_url: rawStart, scope: rawScope, id } = manifest as { start_url?: unknown; scope?: unknown; id?: unknown };
    const start = typeof rawStart === "string" && URL.canParse(rawStart, url) ? new URL(rawStart, url).href : url;
    const scope = typeof rawScope === "string" && URL.canParse(rawScope, url) ? new URL(rawScope, url).href : new URL(".", start).href;
    log.debug({ url, members: members.length, icons: icons.length, start, scope, id }, "manifest read");
    return { members, icons, start, scope, ...(typeof id === "string" && id !== "" && { id }) };
}

const manifestOf = (resource: ResourceFacts) => resource[ID] as ManifestFacts | undefined;
const isManifest = (_page: Facts, resource: ResourceFacts) => resource.kind === "manifest" && manifestOf(resource) !== undefined;
// A manifest that parsed, so its members are judged.
const isParsed = (page: Facts, resource: ResourceFacts) => isManifest(page, resource) && manifestOf(resource)?.error === undefined;
const FACTS = [`resources.${ID}`];

const parse = resourceRule("manifest/parse", isManifest, (resource, pages) => {
    const error = manifestOf(resource)?.error;
    return error ? `manifest does not parse: ${error}; linked from ${pages} pages` : undefined;
}, FACTS, (resource) => manifestOf(resource)?.error, { docs: DOCS, fix: "Serve the manifest as one JSON object." });

const fields = resourceRule("manifest/fields", isParsed, (resource, pages) => {
    const members = new Set(manifestOf(resource)?.members);
    const missing = FIELDS.filter((field) => !members.has(field));
    return missing.length === 0 ? undefined : `manifest lacks ${missing.join(", ")}, so browsers will not offer to install the site; linked from ${pages} pages`;
}, FACTS, (resource) => manifestOf(resource)?.members, { docs: DOCS, fix: `Add ${FIELDS.join(", ")} to the manifest.` });

const icons = resourceRule("manifest/icons", isParsed, (resource, pages) => {
    const all = manifestOf(resource)?.icons ?? [];
    const sizes = new Set(all.flatMap((icon) => icon.sizes));
    const missing = [...SIZES.filter((size) => !sizes.has(size) && !sizes.has("any")), ...(all.some((icon) => icon.purpose.includes("maskable")) ? [] : ["a maskable icon"])];
    return missing.length === 0 ? undefined : `manifest icons lack ${missing.join(", ")}; linked from ${pages} pages`;
}, FACTS, (resource) => manifestOf(resource)?.icons, { docs: "https://web.dev/articles/maskable-icon", fix: "List a 192×192 and a 512×512 icon, and one with `purpose: maskable` whose safe zone holds the logo." });

// Where the manifest is served from, as what, and whether its app stays inside its own scope and origin.
const served = resourceRule("manifest/served", isManifest, (resource, pages) => {
    const facts = manifestOf(resource);
    const type = String(resource.http?.["content-type"] ?? "").split(";", 1)[0]?.trim();
    const origin = new URL(resource.url).origin;
    const problems = [
        ...(type === "application/manifest+json" ? [] : [`served as ${type || "no type"}, not application/manifest+json`]),
        ...(facts?.error === undefined && facts?.id === undefined ? ["no id"] : []),
        ...[facts?.start, facts?.scope].filter((href) => href !== undefined && new URL(href).origin !== origin).map((href) => `${href} is on another origin`),
        ...(facts?.start && facts.scope && !facts.start.startsWith(facts.scope) ? [`start_url ${facts.start} is outside scope ${facts.scope}`] : []),
    ];
    log.debug({ url: resource.url, type, problems: problems.length }, "manifest serving judged");
    return problems.length === 0 ? undefined : `manifest ${problems.join("; ")}; linked from ${pages} pages`;
}, FACTS, (resource) => ({ type: resource.http?.["content-type"], start: manifestOf(resource)?.start, scope: manifestOf(resource)?.scope, id: manifestOf(resource)?.id }), { docs: "https://www.w3.org/TR/appmanifest/#id-member", fix: "Serve the manifest as application/manifest+json with an id, and a start_url inside a scope on the site’s own origin." });

// Whether a page’s head links a manifest.
const isLinked = (page: Facts) => (page.html?.head.links ?? []).some((link) => (link.rel ?? "").toLowerCase().split(/\s+/).includes("manifest"));

// A group where some HTML pages link a manifest and others do not: one finding naming the pages without it.
const discovery: Make = (severity) => ({
    meta: { id: "manifest/discovery", severity, scope: "group", facts: ["html.head.links"], docs: "https://developer.mozilla.org/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable", fix: "Link the manifest with <link rel=manifest> from every page, so the app installs from wherever a visitor lands." },
    check(pages: Facts[], group?: string): Finding[] | undefined {
        const html = pages.filter((page) => page.html !== undefined && page.http.status >= 200 && page.http.status <= 299);
        const without = html.filter((page) => !isLinked(page)).map((page) => page.url.href);
        log.debug({ rule: "manifest/discovery", group, pages: html.length, without: without.length }, "manifest links judged");
        if (without.length === html.length) return;
        return without.length === 0 ? [] : [{ rule: "manifest/discovery", severity, scope: "group", url: without[0] as string, ...(group !== undefined && { group }), message: `${without.length} of ${html.length} pages link no manifest while the rest do`, urls: without }];
    },
});

export default definePlugin({
    name: "manifest",
    resources: [{ id: ID, types: ["application/manifest+json", "application/json"], extract }],
    rules: { "manifest/parse": parse, "manifest/fields": fields, "manifest/icons": icons, "manifest/served": served, "manifest/discovery": discovery },
    presets: {
        manifest: {
            description: "Web app manifest linked from every page, served as a manifest, and carrying what installation needs: name, id, start URL inside its scope, display mode, sized and maskable icons",
            rules: { "manifest/parse": "error", "manifest/fields": "warning", "manifest/icons": "warning", "manifest/served": "warning", "manifest/discovery": "warning" },
        },
    },
});
