// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Facts } from "../src/facts/types.ts";
import { compileRule } from "../src/rules/declarative.ts";
import { presetNames, resolveRuleset } from "../src/rules/rulesets.ts";
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
}

// A 2xx https: HTML page that every rule below passes, with the patch applied.
function page(patch: Patch = {}): Facts {
    const pathname = patch.pathname ?? "/posts/hello-world/";
    const href = `https://site.test${pathname}`;
    const headers = { "strict-transport-security": "max-age=31536000; includeSubDomains", "content-security-policy": "default-src 'self'; upgrade-insecure-requests; require-trusted-types-for 'script'", "referrer-policy": "strict-origin-when-cross-origin", "permissions-policy": "camera=()", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin", "reporting-endpoints": "default=\"/reports\"", "content-encoding": "br", vary: "Accept-Encoding", etag: "\"x\"", "cache-control": "max-age=60", "alt-svc": "h3=\":443\"", ...patch.headers };
    const meta = { viewport: "width=device-width, initial-scale=1", "theme-color": "#000", "color-scheme": "light dark", ...patch.meta };
    return {
        url: { href, origin: "https://site.test", protocol: "https:", host: "site.test", pathname, search: "" },
        group: "default",
        crawl: { depth: 0, discoveredVia: "seed", referrers: [] },
        sitemap: { listed: patch.listed ?? true },
        http: { status: patch.status ?? 200, version: patch.version ?? "2.0", redirects: [], headers, timing: {}, cookies: [], size: { body: 900, decoded: patch.decoded ?? 4096 }, contentType: patch.contentType ?? "text/html; charset=utf-8" },
        html: { lang: patch.lang ?? "en-GB", h1: ["Hello"], meta, property: {}, links: { internal: [], external: [], nofollow: [] }, images: [] },
        resources: (patch.resources ?? ["https://site.test/app.js"]).map((url) => ({ url, kind: "script", origin: "same" })),
        browser: { timing: {}, console: { errors: [], warnings: patch.warnings ?? [] }, weight: {} },
    };
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
    "html/noindex-listed": [{ meta: { robots: "noindex, follow" } }, { meta: { robots: "NONE" } }],
    "url/shape": [{ pathname: "/Posts/" }, { pathname: "/posts/hello_world/" }, { pathname: "/posts//x/" }],
    "resources/a11y-overlay": [{ resources: ["https://acsbapp.com/apps/app/dist/js/app.js"] }, { resources: ["https://cdn.userway.org/widget.js"] }],
    "browser/unused-preload": [{ warnings: ["The resource https://site.test/a.woff2 was preloaded using link preload but not used within a few seconds from the window’s load event."] }],
};

// Pages the rule must pass or skip, beyond the bare `page()`.
const PASSES: Record<string, Patch[]> = {
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
    "html/noindex-listed": [{ meta: { robots: "noindex" }, listed: false }, { meta: { robots: "max-image-preview:large" } }],
    "url/shape": [{ pathname: "/es/ma%C3%B1ana/" }],
};

const specs = resolveRuleset("spiderlint:all", {});
const check = (id: string, patch: Patch) => (compileRule(id, specs[id] ?? {}) as PageRule).check(page(patch)) ?? [];

describe("presets", () => {
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
