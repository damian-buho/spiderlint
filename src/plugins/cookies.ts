// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Ajv2020 } from "ajv/dist/2020.js";
import { getDomain } from "tldts";
import { USER_AGENT } from "../agent.ts";
import type { CookieFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resourceRule } from "../rules/builtin.ts";
import { said } from "../rules/message.ts";
import type { Make, RuleSpec, Severity } from "../rules/types.ts";
import { TRACKING_COOKIES } from "./cookies-registry.ts";
import { definePlugin, type Extractor } from "./types.ts";
import { visit } from "./visit.ts";

// Every hand-kept tracking cookie name as one anchored pattern, `*` as any suffix.
const TRACKING = `^(?:${Object.values(TRACKING_COOKIES)
    .flat()
    .map((name) => name.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", ".*"))
    .join("|")})$`;

const ajv = new Ajv2020({ strictTypes: false });

// One expectation every cookie must meet, judged on page, resource and script cookies alike.
interface Check {
    name: string;
    item: Record<string, unknown>;
    severity: Exclude<Severity, "off">;
    score: number;
    message: string;
    docs: string;
    fix?: string;
    // Judged on `https:` only.
    isHttpsOnly?: true;
    // Meaningless for a cookie a script writes, which can never be HttpOnly.
    isHeaderOnly?: true;
}

const CHECKS: Check[] = [
    { name: "secure", item: { properties: { secure: { const: true } } }, isHttpsOnly: true, severity: "warning", score: 6.5, message: "a cookie is set without the Secure flag", fix: "Add Secure to every cookie set over https:.", docs: "https://developer.mozilla.org/docs/Web/HTTP/Cookies#block_access_to_your_cookies" },
    {
        name: "http-only",
        item: { properties: { "http-only": { const: true } } },
        isHeaderOnly: true,
        severity: "info",
        score: 2.8,
        message: "a cookie is set without the HttpOnly flag",
        fix: "Add HttpOnly to cookies scripts do not need to read.",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Cookies#block_access_to_your_cookies",
    },
    { name: "same-site", item: { required: ["same-site"] }, severity: "info", score: 2.4, message: "a cookie is set without a SameSite attribute", fix: "Set SameSite=Lax or SameSite=Strict on every cookie.", docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#samesitesamesite-value" },
    {
        name: "host-prefix",
        item: { anyOf: [{ not: { properties: { name: { pattern: "^(?i:__Host-)" } } } }, { properties: { secure: { const: true }, path: { const: "/" } }, required: ["path"], not: { required: ["domain"] } }] },
        severity: "warning",
        score: 6,
        message: "a __Host- cookie lacks Secure or Path=/, or sets Domain, so browsers reject it",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes",
        fix: "Add Secure and Path=/, and omit Domain, from every __Host- cookie.",
    },
    {
        name: "secure-prefix",
        item: { anyOf: [{ not: { properties: { name: { pattern: "^(?i:__Secure-)" } } } }, { properties: { secure: { const: true } } }] },
        severity: "warning",
        score: 5.8,
        message: "a __Secure- cookie lacks Secure, so browsers reject it",
        fix: "Add Secure to every __Secure- cookie.",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes",
    },
    {
        name: "same-site-none",
        item: { anyOf: [{ not: { properties: { "same-site": { pattern: "^(?i:none)$" } }, required: ["same-site"] } }, { properties: { secure: { const: true } } }] },
        severity: "warning",
        score: 6.3,
        message: "a SameSite=None cookie lacks Secure, so browsers reject it",
        fix: "Add Secure to every SameSite=None cookie.",
        docs: "https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#none",
    },
    {
        name: "lifetime",
        item: { properties: { "max-age": { maximum: 34_560_000 } } },
        severity: "info",
        score: 1.8,
        message: "a cookie outlives 400 days, which browsers cap",
        fix: "Set Max-Age to 34560000 seconds (400 days) or less.",
        docs: "https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#name-the-max-age-attribute",
    },
];

// The check over every cookie of `fact`, a page rule that folds by group.
function over(fact: string, check: Check): RuleSpec {
    return { fact, expect: { type: "array", items: check.item }, ...(check.isHttpsOnly && { when: { "url.protocol": "https:" } }), severity: check.severity, score: check.score, message: check.message, docs: check.docs, ...(check.fix && { fix: check.fix }) };
}

// What a resource finding names first.
const SUBJECT = "{kind}:";

// The check over each resource’s own Set-Cookie, keyed by resource URL with the pages that load it.
function onResources(check: Check): Make {
    const isValid = ajv.compile(check.item) as (value: unknown) => boolean;
    const failing = (cookies: CookieFacts[] = []) => cookies.filter((cookie) => !isValid(cookie)).map((cookie) => cookie.name);
    return resourceRule(
        `cookies/resource-${check.name}`,
        (_page, resource) => (resource.http?.cookies?.length ?? 0) > 0 && (!check.isHttpsOnly || resource.url.startsWith("https:")),
        (resource) => {
            const names = failing(resource.http?.cookies);
            return names.length === 0 ? undefined : { ...said(`${SUBJECT} ${check.message}; used by these pages`, { kind: resource.kind }), data: { [resource.url]: { cookies: names.join(", ") } } };
        },
        ["resources"],
        (resource) => failing(resource.http?.cookies),
        { docs: check.docs, ...(check.fix && { fix: check.fix }) },
    );
}

const PAGE = Object.fromEntries(CHECKS.map((check) => [`cookies/${check.name}`, over("http.cookies", check)]));
const RESOURCES = Object.fromEntries(CHECKS.map((check) => [`cookies/resource-${check.name}`, onResources(check)]));
const SCRIPTS = Object.fromEntries(CHECKS.filter((check) => !check.isHeaderOnly).map((check) => [`cookies/script-${check.name}`, over("browser.cookies", check)]));

// The registrable domain of `host`, else the host itself for an IP, `localhost` or a bare suffix.
function siteOf(host: string): string {
    const name = host.replace(/^\./, "").toLowerCase();
    return getDomain(name, { allowPrivateDomains: true }) ?? name;
}

// A page script listing the keys scripts wrote to localStorage and sessionStorage, never their values.
const STORAGE = `(() => [["local", localStorage], ["session", sessionStorage]].flatMap(([area, store]) => Object.keys(store).map((name) => ({ area, name }))))()`;

// The jar and storage keys of the page loaded once in a fresh context, before any interaction: never values.
const consent: Extractor = {
    id: "consent",
    mode: "browser",
    cost: "expensive",
    cached: false,
    async extract(page, _body, live) {
        const browser = live?.context().browser();
        if (!browser) return;
        const context = await browser.newContext({ userAgent: USER_AGENT });
        try {
            const fresh = await context.newPage();
            await visit(fresh, page.url.href);
            const site = siteOf(page.url.host.replace(/:\d+$/, ""));
            const jar = await context.cookies();
            const now = Date.now() / 1000;
            const cookies = jar.map((cookie) => ({ name: cookie.name, domain: cookie.domain.replace(/^\./, ""), party: siteOf(cookie.domain) === site ? "first" : "third", ...(cookie.expires > 0 && { lifetime: Math.round(cookie.expires - now) }) }));
            const storage = (await fresh.evaluate(STORAGE)) as { area: string; name: string }[];
            log.debug({ url: page.url.href, site, cookies: cookies.map((cookie) => `${cookie.party}:${cookie.domain}:${cookie.name}`), storage: storage.map((entry) => `${entry.area}:${entry.name}`) }, "cookies and storage before consent read");
            return { cookies, storage };
        } finally {
            await context.close();
        }
    },
};

const BEFORE_CONSENT: RuleSpec = {
    fact: "consent.cookies",
    expect: {
        type: "array",
        items: {
            not: {
                anyOf: [
                    { properties: { party: { const: "third" } }, required: ["party"] },
                    { properties: { name: { pattern: TRACKING } }, required: ["name"] },
                ],
            },
        },
    },
    severity: "info",
    score: 2.6,
    message: "a third-party or tracking cookie is set on first load, before any interaction ({got})",
    fix: "Set analytics and advertising cookies only after the visitor agrees, or drop them.",
    docs: "https://eur-lex.europa.eu/eli/dir/2002/58/art_5/oj",
};

const STORAGE_BEFORE_CONSENT: RuleSpec = {
    fact: "consent.storage",
    expect: { type: "array", maxItems: 0 },
    severity: "info",
    score: 2.2,
    message: "scripts write localStorage or sessionStorage on first load, before any interaction ({got})",
    fix: "Write only what the page strictly needs before the visitor agrees, such as a theme or a cart, and nothing that identifies them.",
    docs: "https://eur-lex.europa.eu/eli/dir/2002/58/art_5/oj",
};

// One set of cookie expectations over the page’s Set-Cookie, each resource’s, and what scripts write through `document.cookie`.
export default definePlugin({
    name: "cookies",
    extractors: [consent],
    rules: RESOURCES,
    presets: {
        cookies: {
            description: "Secure, HttpOnly and SameSite on every cookie a page or resource sets, valid __Host- and __Secure- prefixes, and a lifetime browsers keep",
            rules: { ...PAGE, ...Object.fromEntries(CHECKS.map((check) => [`cookies/resource-${check.name}`, { severity: check.severity, score: check.score }])) },
        },
        "cookies:browser": { description: "The cookie expectations over what scripts write through document.cookie", rules: SCRIPTS },
        privacy: {
            description: "Tracking vendors, and third-party or tracking cookies and web storage set before any interaction",
            extends: ["spiderlint:trackers"],
            when: { "http.status": { minimum: 200, maximum: 299 } },
            rules: { "cookies/before-consent": BEFORE_CONSENT, "cookies/storage-before-consent": STORAGE_BEFORE_CONSENT },
        },
    },
});
