// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Ajv2020 } from "ajv/dist/2020.js";
import type { CookieFacts } from "../facts/types.ts";
import { resourceRule } from "../rules/builtin.ts";
import type { Make, RuleSpec, Severity } from "../rules/types.ts";
import { definePlugin } from "./types.ts";


const ajv = new Ajv2020({ strictTypes: false });

// One expectation every cookie must meet, judged on page, resource and script cookies alike.
interface Check {
    name: string;
    item: Record<string, unknown>;
    severity: Exclude<Severity, "off">;
    message: string;
    docs: string;
    fix?: string;
    // Judged on `https:` only.
    isHttpsOnly?: true;
    // Meaningless for a cookie a script writes, which can never be HttpOnly.
    isHeaderOnly?: true;
}

const CHECKS: Check[] = [
    { name: "secure", item: { properties: { secure: { const: true } } }, isHttpsOnly: true, severity: "warning", message: "a cookie is set without the Secure flag", docs: "https://developer.mozilla.org/docs/Web/HTTP/Cookies#block_access_to_your_cookies" },
    { name: "http-only", item: { properties: { httpOnly: { const: true } } }, isHeaderOnly: true, severity: "info", message: "a cookie is set without the HttpOnly flag", docs: "https://developer.mozilla.org/docs/Web/HTTP/Cookies#block_access_to_your_cookies" },
    { name: "same-site", item: { required: ["sameSite"] }, severity: "info", message: "a cookie is set without a SameSite attribute", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#samesitesamesite-value" },
    {
        name: "host-prefix",
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema’s if/then keyword
        item: { if: { properties: { name: { pattern: "^(?i:__Host-)" } } }, then: { properties: { secure: { const: true }, path: { const: "/" } }, required: ["path"], not: { required: ["domain"] } } },
        severity: "warning",
        message: "a __Host- cookie lacks Secure or Path=/, or sets Domain, so browsers reject it",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes",
    },
    // eslint-disable-next-line unicorn/no-thenable -- JSON Schema’s if/then keyword
    { name: "secure-prefix", item: { if: { properties: { name: { pattern: "^(?i:__Secure-)" } } }, then: { properties: { secure: { const: true } } } }, severity: "warning", message: "a __Secure- cookie lacks Secure, so browsers reject it", fix: "add Secure to every __Secure- cookie", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes" },
    {
        name: "same-site-none",
        // eslint-disable-next-line unicorn/no-thenable -- JSON Schema’s if/then keyword
        item: { if: { properties: { sameSite: { pattern: "^(?i:none)$" } }, required: ["sameSite"] }, then: { properties: { secure: { const: true } } } },
        severity: "warning",
        message: "a SameSite=None cookie lacks Secure, so browsers reject it",
        fix: "add Secure to every SameSite=None cookie",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#none",
    },
    { name: "lifetime", item: { properties: { maxAge: { maximum: 34_560_000 } } }, severity: "info", message: "a cookie outlives 400 days, which browsers cap", fix: "set Max-Age to 34560000 seconds (400 days) or less", docs: "https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#name-the-max-age-attribute" },
];

// The check over every cookie of `fact`, a page rule that folds by group.
function over(fact: string, check: Check): RuleSpec {
    return { fact, expect: { type: "array", items: check.item }, ...(check.isHttpsOnly && { when: { "url.protocol": "https:" } }), severity: check.severity, message: check.message, docs: check.docs, ...(check.fix && { fix: check.fix }) };
}

// The check over each resource’s own Set-Cookie, keyed by resource URL with the pages that load it.
function onResources(check: Check): Make {
    const isValid = ajv.compile(check.item) as (value: unknown) => boolean;
    const failing = (cookies: CookieFacts[] = []) => cookies.filter((cookie) => !isValid(cookie)).map((cookie) => cookie.name);
    return resourceRule(
        `cookies/resource-${check.name}`,
        (_page, resource) => (resource.http?.cookies?.length ?? 0) > 0 && (!check.isHttpsOnly || resource.url.startsWith("https:")),
        (resource, pages) => {
            const names = failing(resource.http?.cookies);
            return names.length === 0 ? undefined : `${resource.kind}: ${check.message} (${names.join(", ")}); used by ${pages} pages`;
        },
        ["resources"],
        (resource) => failing(resource.http?.cookies),
        { docs: check.docs, ...(check.fix && { fix: check.fix }) },
    );
}

const PAGE = Object.fromEntries(CHECKS.map((check) => [`cookies/${check.name}`, over("http.cookies", check)]));
const RESOURCES = Object.fromEntries(CHECKS.map((check) => [`cookies/resource-${check.name}`, onResources(check)]));
const SCRIPTS = Object.fromEntries(CHECKS.filter((check) => !check.isHeaderOnly).map((check) => [`cookies/script-${check.name}`, over("browser.cookies", check)]));

// One set of cookie expectations over the page’s Set-Cookie, each resource’s, and what scripts write through `document.cookie`.
export default definePlugin({
    name: "cookies",
    rules: RESOURCES,
    presets: {
        cookies: { description: "Secure, HttpOnly and SameSite on every cookie a page or resource sets, valid __Host- and __Secure- prefixes, and a lifetime browsers keep", rules: { ...PAGE, ...Object.fromEntries(CHECKS.map((check) => [`cookies/resource-${check.name}`, check.severity])) } },
        "cookies:browser": { description: "The cookie expectations over what scripts write through document.cookie", rules: SCRIPTS },
    },
});
