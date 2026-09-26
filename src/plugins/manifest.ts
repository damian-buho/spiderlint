// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts, ResourceFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resourceRule } from "../rules/builtin.ts";
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
    log.debug({ url, members: members.length, icons: icons.length }, "manifest read");
    return { members, icons };
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

export default definePlugin({
    name: "manifest",
    resources: [{ id: ID, types: ["application/manifest+json", "application/json"], extract }],
    rules: { "manifest/parse": parse, "manifest/fields": fields, "manifest/icons": icons },
    presets: {
        manifest: {
            description: "Web app manifest that parses and carries what installation needs: name, start URL, display mode, sized and maskable icons",
            rules: { "manifest/parse": "error", "manifest/fields": "warning", "manifest/icons": "warning" },
        },
    },
});
