// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { ConfigError, PROFILES, ROLES } from "./index.ts";

const ajv = new Ajv2020({ strictTypes: false, allErrors: true });

const ttl = { oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }] };
const fetchMode = { enum: ["auto", "http", "browser", "adaptive"] };
const severity = { enum: ["error", "warning", "info", "hint", "off"] };
const score = { type: "number", minimum: 0, maximum: 9.9 };
const ruleSpec = {
    type: "object",
    additionalProperties: false,
    properties: {
        fact: { type: "string" },
        expect: { type: "object" },
        when: { type: "object" },
        unique: { type: "string" },
        scope: { enum: ["page", "group", "site"] },
        severity,
        score: { oneOf: [score, { type: "array", minItems: 2, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } } }] },
        docs: { type: "string" },
        fix: { type: "string" },
        message: { type: "string" },
        linked: { type: "boolean" },
    },
};

// The org.spiderlint subtree, as documented in AGENTS.md ## Configuration.
// additionalProperties: false below the top, where an object key is a plugin’s until `configurePlugins` finds none claiming it.
const site = {
    type: "object",
    additionalProperties: { type: "object" },
    properties: {
        targets: { type: "array", items: { type: "string" } },
        "canonical-origin": { type: "string" },
        role: { enum: ROLES },
        resolver: { type: "string" },
        resolve: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "string" } },
        fetch: fetchMode,
        browser: { enum: ["chromium", "firefox", "webkit"] },
        "browser-install": { type: "boolean" },
        scope: { enum: ["origin", "host", "domain"] },
        concurrency: { type: "integer", minimum: 0 },
        rate: { type: "integer", minimum: 0 },
        timeout: { type: "integer", minimum: 1 },
        profile: { enum: Object.keys(PROFILES) },
        "max-pages": { type: "integer", minimum: 0 },
        "max-depth": { type: "integer", minimum: 0 },
        "max-body-size": { type: "integer", minimum: 0 },
        keepalive: { type: "boolean" },
        "allow-private": { type: "boolean" },
        "include-urls": { type: "array", items: { type: "string" } },
        "exclude-urls": { type: "array", items: { type: "string" } },
        "vendor-paths": { type: "boolean" },
        diversify: { type: "boolean" },
        resources: {
            type: "object",
            additionalProperties: false,
            properties: { fetch: { type: "boolean" }, "max-per-page": { type: "integer", minimum: 0 } },
        },
        links: { type: "object", additionalProperties: false, properties: { exclude: { type: "array", items: { type: "string", minLength: 1 } } } },
        proxy: { type: "string" },
        robots: { type: "boolean" },
        sitemap: { type: "boolean" },
        fold: { oneOf: [{ const: false }, { type: "object", additionalProperties: false, properties: { threshold: { type: "number", minimum: 0, maximum: 1 }, min: { type: "integer", minimum: 1 } } }] },
        cache: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(["pages", "probes", "profiles", "resources", "robots", "sitemaps", "origins", "dns", "extractors"].map((bucket) => [bucket, { type: "object", additionalProperties: false, properties: { ttl, ...(bucket === "resources" && { "failure-ttl": ttl }) } }])),
        },
        "fail-on": { oneOf: [{ enum: ["error", "warning", "info", "never"] }, { type: "number", minimum: 0.1, maximum: 9.9 }] },
        format: { type: "string" },
        plugins: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "string" } },
        "exclude-rules": { type: "array", items: { type: "string" } },
        "document-types": { type: "array", items: { type: "string", pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+$" } },
        override: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(["error", "warning", "info", "hint"].map((level) => [level, { type: "array", items: { type: "string" } }])),
        },
        groups: {
            type: "object",
            additionalProperties: { type: "object", additionalProperties: false, properties: { match: { type: "array", items: { type: "string" } }, rules: { type: "array", items: { type: "string" } }, fetch: fetchMode, sample: { oneOf: [{ type: "integer", minimum: 1 }, { const: "all" }] } } },
        },
        rulesets: {
            type: "object",
            additionalProperties: {
                type: "object",
                additionalProperties: false,
                properties: {
                    description: { type: "string" },
                    extends: { type: "array", items: { type: "string" } },
                    when: { type: "object" },
                    rules: { type: "object", additionalProperties: { oneOf: [severity, score, ruleSpec] } },
                },
            },
        },
    },
};

// Keys the core reads; any other top-level key belongs to a plugin.
export const CORE_KEYS = new Set([...Object.keys(site.properties), "sites"]);

// Each `sites.<name>` entry carries the same keys as the subtree, minus `sites`.
const schema = { ...site, properties: { ...site.properties, sites: { type: "object", additionalProperties: site } } };

const validate = ajv.compile(schema);

// Schema paths where a top-level key that is no object can only be a misspelt core key.
const TOP_LEVEL = new Set(["#/additionalProperties/type", "#/properties/sites/additionalProperties/additionalProperties/type"]);

// A misspelt or misplaced key names its own path under `prefix`, per AGENTS.md ## Configuration.
export function describe(error: ErrorObject, prefix = "org.spiderlint"): string {
    if (error.keyword === "additionalProperties") {
        const key = (error.params as { additionalProperty: string }).additionalProperty;
        return `${prefix}${error.instancePath}: unknown key "${key}"`;
    }
    const cut = error.instancePath.lastIndexOf("/");
    return TOP_LEVEL.has(error.schemaPath) ? `${prefix}${error.instancePath.slice(0, cut)}: unknown key "${error.instancePath.slice(cut + 1)}"` : `${prefix}${error.instancePath}: ${error.message}`;
}

// Throws ConfigError (exit 2) listing every violation found in the subtree.
// `value` must already be an object (an absent subtree is the caller's `{}`, not `undefined`).
export function validateSubtree(value: unknown, prefix = "org.spiderlint"): Record<string, unknown> {
    if (!validate(value)) {
        throw new ConfigError((validate.errors ?? []).map((error) => describe(error, prefix)).join("; "));
    }
    return value as Record<string, unknown>;
}
