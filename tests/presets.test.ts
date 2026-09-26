// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { robotsFacts } from "../src/facts/robots.ts";
import type { Facts, HtmlFacts, RedirectHop } from "../src/facts/types.ts";
import { compileRule } from "../src/rules/declarative.ts";
import { compileRulesets, presetNames, resolveRuleset } from "../src/rules/rulesets.ts";
import type { PageRule } from "../src/rules/types.ts";

interface Patch {
    status?: number;
    version?: string;
    headers?: Record<string, string>;
    contentType?: string;
    decoded?: number;
    pathname?: string;
    listed?: boolean;
    meta?: Record<string, string>;
    lang?: string;
    resources?: string[];
    warnings?: string[];
    html?: Partial<HtmlFacts>;
    redirects?: RedirectHop[];
}

// A 2xx https: HTML page that every rule below passes, with the patch applied and robots derived as the linter does.
function page(patch: Patch = {}): Facts {
    const pathname = patch.pathname ?? "/posts/hello-world/";
    const href = `https://site.test${pathname}`;
    const headers = { "strict-transport-security": "max-age=31536000; includeSubDomains", "content-security-policy": "default-src 'self'; upgrade-insecure-requests; require-trusted-types-for 'script'", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=()", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin", "reporting-endpoints": "default=\"/reports\"", "content-encoding": "br", vary: "Accept-Encoding", etag: "\"x\"", "cache-control": "max-age=60", "alt-svc": "h3=\":443\"", ...patch.headers };
    const meta = { viewport: "width=device-width, initial-scale=1", "theme-color": "#000", "color-scheme": "light dark", ...patch.meta };
    const facts: Facts = {
        url: { href, origin: "https://site.test", protocol: "https:", host: "site.test", pathname, search: "" },
        group: "default",
        crawl: { depth: 0, discoveredVia: "seed", referrers: [] },
        sitemap: { listed: patch.listed ?? true },
        http: { status: patch.status ?? 200, version: patch.version ?? "2.0", redirects: patch.redirects ?? [], headers, timing: {}, cookies: [], size: { body: 900, decoded: patch.decoded ?? 4096 }, contentType: patch.contentType ?? "text/html; charset=utf-8" },
        html: { lang: patch.lang ?? "en-GB", charset: { declared: "utf8", offset: 300 }, h1: ["Hello"], meta, property: {}, metas: [{ name: "theme-color", content: "#fff", media: "(prefers-color-scheme: light)" }, { name: "theme-color", content: "#000", media: "(prefers-color-scheme: dark)" }], head: { links: [{ rel: "icon", href: "https://site.test/favicon.svg" }] }, hreflang: [], jsonld: [{ "@type": "WebPage" }], scripts: [{ src: "https://site.test/app.js", type: "module", async: false, defer: false, head: true }], links: { internal: [], external: [], nofollow: [] }, images: [{ src: "/a.png", alt: "", width: "10", height: "10" }], rels: { "privacy-policy": ["https://site.test/privacy/"] }, inputs: [], ...patch.html },
        resources: (patch.resources ?? ["https://site.test/app.js"]).map((url) => ({ url, kind: "script", origin: "same" })),
        browser: { timing: {}, console: { errors: [], warnings: patch.warnings ?? [] }, weight: {}, cookies: [] },
    };
    facts.robots = robotsFacts(facts);
    return facts;
}

// Rule ID → pages it must flag; every rule also passes on the bare `page()`.
const FAILS: Record<string, Patch[]> = {
    "http/hsts-subdomains": [{ headers: { "strict-transport-security": "max-age=31536000" } }],
    "http/referrer-policy": [{ headers: { "referrer-policy": "unsafe-url" } }, { headers: { "referrer-policy": "no-referrer, no-referrer-when-downgrade" } }],
    "http/permissions-policy": [{ headers: { "permissions-policy": "" } }],
    "http/coop": [{ headers: { "cross-origin-opener-policy": "unsafe-none" } }],
    "http/corp": [{ headers: { "cross-origin-resource-policy": "" } }],
    "http/csp-upgrade-insecure": [{ headers: { "content-security-policy": "default-src 'self'" } }],
    "http/csp-trusted-types": [{ headers: { "content-security-policy": "default-src 'self'" } }],
    "http/reporting-endpoints": [{ headers: { "reporting-endpoints": "" } }],
    "http/no-x-xss-protection": [{ headers: { "x-xss-protection": "1; mode=block" } }],
    "http/compression": [{ headers: { "content-encoding": "deflate" } }, { contentType: "application/ld+json", headers: { "content-encoding": "identity" } }],
    "http/vary-encoding": [{ headers: { vary: "Origin" } }],
    "http/vary-star": [{ headers: { vary: "*" } }],
    "http/validator": [{ headers: { etag: undefined as unknown as string } }],
    "http/html-cache-control": [{ headers: { "cache-control": "" } }],
    "http/no-store-bfcache": [{ headers: { "cache-control": "private, no-store" } }],
    "http/version": [{ version: "1.1" }],
    "http/alt-svc-h3": [{ headers: { "alt-svc": "h2=\":443\"" } }],
    "http/retry-after": [{ status: 503 }],
    "http/sunset-format": [{ headers: { sunset: "2027-01-01" } }],
    "http/deprecation-format": [{ headers: { deprecation: "true" } }],
    "html/lang": [{ lang: "english" }, { lang: "en_GB" }],
    "html/viewport": [{ meta: { viewport: "initial-scale=1" } }, { meta: { viewport: "width=device-width, user-scalable=no" } }, { meta: { viewport: "width=device-width, maximum-scale=1.0" } }],
    "html/theme-color": [{ meta: { "theme-color": "" } }],
    "html/color-scheme": [{ meta: { "color-scheme": "" } }],
    "html/theme-color-schemes": [{ html: { metas: [{ name: "theme-color", content: "#000" }] } }, { html: { metas: [{ name: "theme-color", content: "#fff" }, { name: "theme-color", content: "#000" }] } }],
    "html/noindex-listed": [{ meta: { robots: "noindex, follow" } }, { meta: { robots: "NONE" } }, { headers: { "x-robots-tag": "googlebot: noindex" } }],
    "html/dir-rtl": [{ lang: "ar" }, { lang: "he-IL", html: { dir: "ltr" } }],
    "html/charset": [{ html: { charset: { declared: "windows-1252", offset: 300 } } }, { html: { charset: { declared: "utf8", offset: 1500 } } }, { html: { charset: undefined } }],
    "html/favicon": [{ html: { head: { links: [{ rel: "apple-touch-icon", href: "/a.png" }] } } }],
    "html/hreflang-x-default": [{ html: { hreflang: [{ lang: "en", href: "https://site.test/" }] } }],
    "html/jsonld-parses": [{ html: { jsonld: [{ "@error": "Unexpected token" }] } }],
    "html/render-blocking-script": [{ html: { scripts: [{ src: "https://site.test/a.js", async: false, defer: false, head: true }] } }],
    "html/img-dimensions": [{ html: { images: [{ src: "/a.png", alt: "" }] } }],
    "html/first-img-lazy": [{ html: { images: [{ src: "/hero.png", alt: "", loading: "LAZY" }] } }],
    "html/privacy-policy": [{ html: { rels: {} } }, { html: { rels: { "privacy-policy": [] } } }],
    "url/shape": [{ pathname: "/Posts/" }, { pathname: "/posts/hello_world/" }, { pathname: "/posts//x/" }],
    "resources/a11y-overlay": [{ resources: ["https://acsbapp.com/apps/app/dist/js/app.js"] }, { resources: ["https://cdn.userway.org/widget.js"] }],
    "browser/unused-preload": [{ warnings: ["The resource https://site.test/a.woff2 was preloaded using link preload but not used within a few seconds from the window’s load event."] }],
    "redirects/permanent": [{ redirects: [{ url: "https://site.test/a", status: 301 }, { url: "https://site.test/b", status: 302 }] }, { redirects: [{ url: "https://site.test/b", status: 307 }] }],
};

// Pages the rule must pass or skip, beyond the bare `page()`.
const PASSES: Record<string, Patch[]> = {
    "redirects/permanent": [{ redirects: [{ url: "https://site.test/a", status: 301 }, { url: "https://site.test/b", status: 308 }] }, { status: 404, redirects: [{ url: "https://site.test/b", status: 302 }] }],
    "http/referrer-policy": [{ headers: { "referrer-policy": "unsafe-url, no-referrer" } }],
    "http/no-x-xss-protection": [{ headers: { "x-xss-protection": "0" } }],
    "http/compression": [{ decoded: 512, headers: { "content-encoding": "identity" } }, { contentType: "image/png", headers: { "content-encoding": "identity" } }],
    "http/validator": [{ headers: { etag: undefined as unknown as string, "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" } }],
    "http/no-store-bfcache": [{ contentType: "application/json", headers: { "cache-control": "no-store" } }],
    "http/retry-after": [{ status: 503, headers: { "retry-after": "120" } }],
    "http/sunset-format": [{ headers: { sunset: "Fri, 01 Jan 2027 00:00:00 GMT" } }],
    "http/deprecation-format": [{ headers: { deprecation: "@1767225600" } }],
    "html/lang": [{ lang: "zh-Hant-TW" }, { lang: "es-419" }],
    "html/viewport": [{ meta: { viewport: "width=device-width, maximum-scale=1.5" } }],
    "html/theme-color-schemes": [{ meta: { "color-scheme": "light" }, html: { metas: [{ name: "theme-color", content: "#fff" }] } }, { html: { metas: [{ name: "theme-color", content: "#fff" }, { name: "theme-color", content: "#000", media: "(prefers-color-scheme: dark)" }] } }],
    "html/noindex-listed": [{ meta: { robots: "noindex" }, listed: false }, { meta: { robots: "max-image-preview:large" } }, { headers: { "x-robots-tag": "nofollow" } }],
    "html/dir-rtl": [{ lang: "ar-EG", html: { dir: "rtl" } }, { lang: "arn" }],
    "html/charset": [{ html: { charset: { declared: "utf8", offset: 1024 } } }],
    "html/favicon": [{ html: { head: { links: [{ rel: "shortcut icon", href: "/favicon.ico" }] } } }],
    "html/hreflang-x-default": [{ html: { hreflang: [{ lang: "en", href: "https://site.test/" }, { lang: "x-default", href: "https://site.test/" }] } }],
    "html/render-blocking-script": [{ html: { scripts: [{ src: "https://site.test/a.js", async: false, defer: true, head: true }, { src: "https://site.test/b.js", async: false, defer: false, head: false }, { async: false, defer: false, head: true }] } }],
    "html/img-dimensions": [{ html: { images: [{ src: "/pixel.gif", alt: "", noscript: true }] } }],
    "html/first-img-lazy": [{ html: { images: [] } }, { html: { images: [{ src: "/hero.png", alt: "", loading: "eager" }, { src: "/below.png", alt: "", loading: "lazy" }] } }],
    "url/shape": [{ pathname: "/es/ma%C3%B1ana/" }],
};

const specs = resolveRuleset("spiderlint:all", {});
const check = (id: string, patch: Patch) => (compileRule(id, specs[id] ?? {}) as PageRule).check(page(patch)) ?? [];

describe("presets", () => {
    it("excludes and overrides rules by ID or glob", () => {
        const spec = { fact: "html.title", expect: { minLength: 3 } };
        const rulesets = { t: { rules: { "a/x": spec, "a/y": spec, "b/z": spec } } };
        const severities = (excluded: string[], overrides = {}) => Object.fromEntries(compileRulesets(["t"], rulesets, new Set(excluded), overrides).map((rule) => [rule.meta.id, rule.meta.severity]));
        assert.deepEqual(Object.keys(severities(["a/*"])), ["b/z"]);
        assert.deepEqual(Object.keys(severities(["a/x"])), ["a/y", "b/z"]);
        assert.deepEqual(Object.keys(severities(["**"])), []);
        assert.deepEqual(severities([], { "a/*": "info", "a/y": "error" }), { "a/x": "info", "a/y": "error", "b/z": "warning" });
    });

    it("lists performance, and recommended extends it", () => {
        assert.ok(presetNames().includes("performance"));
        assert.ok(Object.hasOwn(resolveRuleset("spiderlint:recommended", {}), "http/compression"));
    });

    for (const id of Object.keys(FAILS)) {
        it(`${id} passes a clean page and flags a broken one`, () => {
            const passes = [{}, ...(PASSES[id] ?? [])];
            for (const patch of passes) assert.deepEqual(check(id, patch), [], `${id} on ${JSON.stringify(patch)}`);
            const fails = FAILS[id] ?? [];
            for (const patch of fails) {
                const [finding] = check(id, patch);
                assert.equal(finding?.rule, id, `${id} on ${JSON.stringify(patch)}`);
                assert.ok(!finding.message.includes("{got}"), finding.message);
            }
        });
    }
});
