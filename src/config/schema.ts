// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { ConfigError } from "./index.ts";

const ajv = new Ajv2020({ strictTypes: false, allErrors: true });

const ttl = { oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }] };
const fetchMode = { enum: ["auto", "http", "browser", "adaptive"] };
const severity = { enum: ["error", "warning", "info", "off"] };
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
        docs: { type: "string" },
    },
};

// The org.spiderlint subtree, as documented in AGENTS.md ## Configuration.
// additionalProperties: false at every level so a misspelt key fails closed.
const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
        targets: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "string" } },
        fetch: fetchMode,
        browser: { enum: ["chromium", "firefox", "webkit"] },
        scope: { enum: ["origin", "host", "domain"] },
        concurrency: { type: "integer", minimum: 0 },
        rate: { type: "integer", minimum: 0 },
        "max-pages": { type: "integer", minimum: 0 },
        "max-depth": { type: "integer", minimum: 0 },
        "max-body-size": { type: "integer", minimum: 0 },
        keepalive: { type: "boolean" },
        include: { type: "array", items: { type: "string" } },
        exclude: { type: "array", items: { type: "string" } },
        resources: {
            type: "object",
            additionalProperties: false,
            properties: { fetch: { type: "boolean" }, "max-per-page": { type: "integer", minimum: 0 } },
        },
        proxy: { type: "string" },
        robots: { type: "boolean" },
        sitemap: { type: "boolean" },
        fold: { oneOf: [{ const: false }, { type: "object", additionalProperties: false, properties: { threshold: { type: "number", minimum: 0, maximum: 1 }, min: { type: "integer", minimum: 1 } } }] },
        cache: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(["pages", "probes", "resources", "robots", "sitemaps"].map((bucket) => [bucket, { type: "object", additionalProperties: false, properties: { ttl } }])),
        },
        "fail-on": { enum: ["error", "warning", "info", "never"] },
        format: { enum: ["human", "json", "sarif"] },
        plugins: { type: "array", items: { type: "string" } },
        "disabled-rules": { type: "array", items: { type: "string" } },
        override: {
            type: "object",
            additionalProperties: false,
            properties: { error: { type: "array", items: { type: "string" } }, warning: { type: "array", items: { type: "string" } }, info: { type: "array", items: { type: "string" } } },
        },
        groups: {
            type: "object",
            additionalProperties: { type: "object", additionalProperties: false, properties: { match: { type: "array", items: { type: "string" } }, rules: { type: "array", items: { type: "string" } }, fetch: fetchMode } },
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
                    rules: { type: "object", additionalProperties: { oneOf: [severity, ruleSpec] } },
                },
            },
        },
    },
};

const validate = ajv.compile(schema);

// A misspelt or misplaced key names its own path, per AGENTS.md ## Configuration.
function describe(error: ErrorObject): string {
    if (error.keyword === "additionalProperties") {
        const key = (error.params as { additionalProperty: string }).additionalProperty;
        return `org.spiderlint${error.instancePath}: unknown key "${key}"`;
    }
    return `org.spiderlint${error.instancePath}: ${error.message}`;
}

// Throws ConfigError (exit 2) listing every violation found in the subtree.
// `value` must already be an object (an absent subtree is the caller's `{}`, not `undefined`).
export function validateSubtree(value: unknown): Record<string, unknown> {
    if (!validate(value)) {
        throw new ConfigError((validate.errors ?? []).map((error) => describe(error)).join("; "));
    }
    return value as Record<string, unknown>;
}
