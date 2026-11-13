// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cspFacts } from "../src/facts/csp.ts";
import { documentFacts, parsedHeaders } from "../src/facts/headers.ts";
import { robotsFacts } from "../src/facts/robots.ts";
import type { Facts, HtmlFacts, RedirectHop, Role, Stance, TlsFacts } from "../src/facts/types.ts";
import { compileRule } from "../src/rules/declarative.ts";
import { isBrowserFact } from "../src/plugins/index.ts";
import { WEB_PRESETS } from "../src/server/policy.ts";
import { compileRulesets, isRuleMatch, presetNames, resolveRuleset } from "../src/rules/rulesets.ts";
import { builtin } from "../src/rules/builtin.ts";
import { isPageRule, type AggregateRule, type Finding, type PageRule } from "../src/rules/types.ts";

interface Patch {
    role?: Role;
    stance?: Stance;
    status?: number;
    version?: string;
    headers?: Record<string, string>;
    contentType?: string;
    decoded?: number;
    pathname?: string;
    search?: string;
    twin?: string;
    listed?: boolean;
    meta?: Record<string, string>;
    lang?: string;
    resources?: string[];
    warnings?: string[];
    html?: Partial<HtmlFacts>;
    redirects?: RedirectHop[];
    daysLeft?: number;
    cert?: Partial<TlsFacts["cert"]>;
}

// A 2xx https: HTML page that every rule below passes, with the patch applied and robots derived as the linter does.
function page(patch: Patch = {}): Facts {
    const pathname = patch.pathname ?? "/posts/hello-world/";
    const href = `https://site.test${pathname}${patch.search ?? ""}`;
    const headers = {
        date: "Sun, 06 Nov 1994 08:49:37 GMT",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "content-security-policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=()",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "reporting-endpoints": 'default="/reports"',
        "content-encoding": "br",
        vary: "Accept-Encoding",
        etag: '"x"',
        "cache-control": "max-age=60",
        "alt-svc": 'h3=":443"',
        "cross-origin-embedder-policy": "credentialless",
        "repr-digest": "sha-256=:x:",
        "server-timing": "app;dur=1",
        "x-content-type-options": "nosniff",
        ...patch.headers,
    };
    const meta = { viewport: "width=device-width, initial-scale=1", "theme-color": "#000", "color-scheme": "light dark", "fediverse:creator": "@ana@social.example", ...patch.meta };
    const facts: Facts = {
        url: { href, origin: "https://site.test", protocol: "https:", host: "site.test", pathname, search: patch.search ?? "", ...(patch.twin && { twin: patch.twin }) },
        group: "default",
        crawl: { depth: 0, "discovered-via": "seed", referrers: [] },
        sitemap: { listed: patch.listed ?? true },
        http: { status: patch.status ?? 200, version: patch.version ?? "2.0", redirects: patch.redirects ?? [], headers, timing: {}, cookies: [], size: { body: 900, decoded: patch.decoded ?? 4096 }, "content-type": patch.contentType ?? "text/html; charset=utf-8" },
        html: {
            lang: patch.lang ?? "en-GB",
            charset: { declared: "utf8", offset: 300 },
            h1: ["Hello"],
            canonical: href,
            meta,
            property: { "og:title": "Hello world, a first post", "og:description": "A first post on the test site, long enough to fill a preview card.", "og:image": "https://site.test/og.png", "og:type": "article", "og:url": href },
            metas: [
                { name: "theme-color", content: "#fff", media: "(prefers-color-scheme: light)" },
                { name: "theme-color", content: "#000", media: "(prefers-color-scheme: dark)" },
            ],
            head: { links: [{ rel: "icon", href: "https://site.test/favicon.svg" }] },
            hreflang: [],
            jsonld: [{ "@type": "WebPage" }],
            scripts: [
                { src: "https://site.test/app.js", type: "module", async: false, defer: false, head: true },
                { type: "speculationrules", async: false, defer: false, head: false },
            ],
            links: { internal: [], external: [], nofollow: [] },
            images: [{ src: "/a.png", alt: "", width: "10", height: "10" }],
            rels: { "privacy-policy": ["https://site.test/privacy/"] },
            inputs: [],
            ...patch.html,
        },
        resources: (patch.resources ?? ["https://site.test/app.js"]).map((url) => ({ url, kind: "script", origin: "same" })),
        tls: { authorized: true, cert: { san: [], "days-left": patch.daysLeft ?? 60, key: { type: "EC", curve: "P-256" }, signatures: ["ecdsa-with-SHA256", "sha256WithRSAEncryption"], ...patch.cert } },
        browser: { timing: {}, console: { errors: [], warnings: patch.warnings ?? [] }, weight: {}, cookies: [] },
    };
    facts.robots = robotsFacts(facts);
    const csp = cspFacts(facts);
    if (csp) facts.http.csp = csp;
    const parsed = parsedHeaders(href, headers);
    if (parsed) facts.http.parsed = parsed;
    documentFacts([facts], []);
    return facts;
}

// Rule ID → pages it must flag; every rule also passes on the bare `page()`.
const FAILS: Record<string, Patch[]> = {
    "http/hsts-subdomains/missing": [{ headers: { "strict-transport-security": "max-age=31536000" } }],
    "http/referrer-policy/insecure": [{ headers: { "referrer-policy": "unsafe-url" } }, { headers: { "referrer-policy": "no-referrer, no-referrer-when-downgrade" } }],
    "http/permissions-policy/missing": [{ headers: { "permissions-policy": "" } }],
    "http/coop/weak": [{ headers: { "cross-origin-opener-policy": "unsafe-none" } }],
    "http/corp/invalid": [{ headers: { "cross-origin-resource-policy": "" } }],
    "http/csp/missing": [{ headers: { "content-security-policy": undefined as unknown as string, "content-security-policy-report-only": "default-src 'self'" } }],
    "http/csp-upgrade-insecure/missing": [{ headers: { "content-security-policy": "default-src 'self'" } }],
    "http/csp-trusted-types/missing": [{ headers: { "content-security-policy": "default-src 'self'" } }, { headers: { "content-security-policy": "require-trusted-types-for 'none'" } }],
    "http/csp-script-src/missing": [{ headers: { "content-security-policy": "img-src 'self'; object-src 'none'" } }],
    "http/csp-unsafe-inline/present": [{ headers: { "content-security-policy": "default-src 'self' 'unsafe-inline'" } }, { headers: { "content-security-policy": "default-src 'self'; script-src 'self' 'UNSAFE-INLINE'" } }],
    "http/csp-unsafe-eval/present": [{ headers: { "content-security-policy": "script-src 'self' 'unsafe-eval'" } }, { headers: { "content-security-policy": "default-src 'unsafe-eval', img-src *" } }],
    "http/csp-script-src/insecure": [{ headers: { "content-security-policy": "script-src *" } }, { headers: { "content-security-policy": "default-src https:" } }],
    "http/csp-object-src/weak": [{ headers: { "content-security-policy": "default-src 'self'" } }, { headers: { "content-security-policy": "default-src 'none'; object-src 'self'" } }],
    "http/csp-base-uri/missing": [{ headers: { "content-security-policy": "default-src 'self'" } }],
    "http/csp-frame-ancestors/missing": [{ headers: { "content-security-policy": "default-src 'self'" } }, { headers: { "content-security-policy": "default-src 'self'" }, html: { "http-equiv": [{ name: "content-security-policy", content: "frame-ancestors 'none'" }] } }],
    "http/reporting-endpoints/missing": [{ headers: { "reporting-endpoints": "" } }],
    "http/hsts/weak": [{ headers: { "strict-transport-security": "max-age=300" } }],
    "http/hsts/invalid": [{ headers: { "strict-transport-security": "max-age=abc" } }, { headers: { "strict-transport-security": "max-age=31536000, max-age=0" } }, { headers: { "strict-transport-security": "includeSubDomains" } }],
    "http/csp/invalid": [{ headers: { "content-security-policy": "default-src self" } }, { headers: { "content-security-policy": "scrpit-src 'self'" } }, { headers: { "content-security-policy": "default-src 'none' 'self'" } }],
    "http/permissions-policy/invalid": [{ headers: { "permissions-policy": "camera=(self" } }, { headers: { "permissions-policy": "camera 'none'" } }, { headers: { "permissions-policy": "camera=none" } }],
    "http/referrer-policy/invalid": [{ headers: { "referrer-policy": "strict" } }],
    "http/coop/invalid": [{ headers: { "cross-origin-opener-policy": "same-site" } }],
    "http/coep/invalid": [{ headers: { "cross-origin-embedder-policy": "require-corp;" } }],
    "http/reporting-endpoints/invalid": [{ headers: { "reporting-endpoints": "default=/reports" } }],
    "http/cache-control/invalid": [{ headers: { "cache-control": "banana" } }, { headers: { "cache-control": "max-age=1h" } }, { headers: { "cache-control": "min-fresh=60" } }, { headers: { "cache-control": "no-store=1" } }],
    "http/vary/invalid": [{ headers: { vary: "Accept Encoding" } }],
    "http/content-type/invalid": [{ headers: { "content-type": "html" } }, { headers: { "content-type": "text/html; utf-8" } }],
    "http/use-as-dictionary/invalid": [{ headers: { "use-as-dictionary": "match=/app-*.js" } }],
    "http/accept-ch/invalid": [{ headers: { "accept-ch": "Sec-CH-UA;;" } }],
    "http/priority/invalid": [{ headers: { priority: "u=high" } }],
    "http/cache-status/invalid": [{ headers: { "cache-status": "Cache; hit=" } }],
    "http/retry-after/weak": [
        { status: 503, headers: { "retry-after": "1" } },
        { status: 429, headers: { "retry-after": "Sun, 06 Nov 1994 08:49:30 GMT" } },
    ],
    "http/retry-after/invalid": [{ headers: { "retry-after": "2m" } }, { headers: { "retry-after": "-5" } }, { headers: { "retry-after": "Mon, 31 Feb 2027 00:00:00 GMT" } }, { headers: { "retry-after": "2027-01-01T00:00:00Z" } }],
    "http/x-xss-protection/insecure": [{ headers: { "x-xss-protection": "1; mode=block" } }],
    "url/href/length": [{ pathname: `/posts/${"very-long-words-".repeat(6)}/` }],
    "url/uppercase/present": [{ pathname: "/Posts/hello-world/" }],
    "url/session-param/present": [{ search: "?sid=4f2a" }, { pathname: "/posts/hello-world;jsessionid=4F2A" }],
    "url/double-slash/present": [{ pathname: "/posts//hello-world/" }],
    "url/extension/present": [{ pathname: "/posts/hello-world.php" }, { pathname: "/index.HTML" }],
    "url/slug/unreadable": [{ pathname: "/p/8f3a91c" }, { pathname: "/p/1234" }, { pathname: "/p/0b8e6f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b" }, { pathname: "/p/spring-recipes/", html: { h1: ["Summer salads"] } }],
    "http/date/invalid": [{ headers: { date: "Sunday, 06-Nov-94 08:49:37 GMT" } }],
    "http/header/deprecated": [{ headers: { "x-xss-protection": "0" } }, { headers: { "report-to": '{"group":"default","max_age":86400,"endpoints":[{"url":"https://site.test/reports"}]}' } }, { headers: { "feature-policy": "camera 'none'", "expect-ct": "max-age=0" } }],
    "links/internal-nofollow/present": [{ html: { links: { internal: ["https://site.test/login"], external: [], nofollow: ["https://site.test/login"] } } }],
    "http/compression/weak": [{ headers: { "content-encoding": "deflate" } }, { contentType: "application/ld+json", headers: { "content-encoding": "identity" } }],
    "http/vary-accept-encoding/missing": [{ headers: { vary: "Origin" } }],
    "http/vary-star/present": [{ headers: { vary: "*" } }],
    "http/validator/missing": [{ headers: { etag: undefined as unknown as string } }],
    "http/cache-control/missing": [{ headers: { "cache-control": "" } }],
    "http/no-store/present": [{ headers: { "cache-control": "private, no-store" } }],
    "http/version/outdated": [{ version: "1.1" }],
    "http/alt-svc-h3/missing": [{ headers: { "alt-svc": 'h2=":443"' } }, { headers: { "alt-svc": "clear" } }, { headers: { "alt-svc": undefined as unknown as string } }],
    "http/alt-svc/invalid": [{ headers: { "alt-svc": "h3=:443" } }, { headers: { "alt-svc": 'h3="443"' } }, { headers: { "alt-svc": 'h3=":443"; ma=1d' } }],
    "http/retry-after/missing": [{ status: 503 }],
    "http/sunset/invalid": [{ headers: { sunset: "2027-01-01" } }],
    "http/deprecation/invalid": [{ headers: { deprecation: "true" } }],
    "html/lang/invalid": [{ lang: "english" }, { lang: "en_GB" }],
    "html/viewport/inaccessible": [{ meta: { viewport: "initial-scale=1" } }, { meta: { viewport: "width=device-width, user-scalable=no" } }, { meta: { viewport: "width=device-width, maximum-scale=1.0" } }],
    "html/theme-color/missing": [{ meta: { "theme-color": "" } }],
    "html/theme-color/invalid": [
        { html: { metas: [{ name: "theme-color", content: "blue-ish" }] } },
        { html: { metas: [{ name: "Theme-Color", content: " " }] } },
        {
            html: {
                metas: [
                    { name: "theme-color", content: "#fff" },
                    { name: "theme-color", content: "12px", media: "(prefers-color-scheme: dark)" },
                ],
            },
        },
    ],
    "html/color-scheme/invalid": [{ meta: { "color-scheme": "" } }, { meta: { "color-scheme": "light, dark" } }, { meta: { "color-scheme": "normal dark" } }, { meta: { "color-scheme": "only" } }],
    "html/viewport/invalid": [{ meta: { viewport: "width=device-width, initial-scale=1, shrink-to-fit=no" } }, { meta: { viewport: "width=device-width, viewport-fit=full" } }, { meta: { viewport: "width=device-width, initial-scale" } }],
    "html/og-image/invalid": [{ html: { property: { "og:image": "https://" } } }, { html: { property: { "og:image": "/og.png" } } }],
    "html/og-url/invalid": [{ html: { property: { "og:url": "https://site test/posts/" } } }],
    "html/og-type/invalid": [{ html: { property: { "og:type": "blog" } } }, { html: { property: { "og:type": "" } } }],
    "html/theme-color-dark/missing": [
        { html: { metas: [{ name: "theme-color", content: "#000" }] } },
        {
            html: {
                metas: [
                    { name: "theme-color", content: "#fff" },
                    { name: "theme-color", content: "#000" },
                ],
            },
        },
    ],
    "html/noindex/mismatch": [{ meta: { robots: "noindex, follow" } }, { meta: { robots: "NONE" } }, { headers: { "x-robots-tag": "googlebot: noindex" } }],
    "html/dir/missing": [{ lang: "ar" }, { lang: "he-IL", html: { dir: "ltr" } }],
    "html/charset/invalid": [{ html: { charset: { declared: "windows-1252", offset: 300 } } }, { html: { charset: { declared: "utf8", offset: 1500 } } }],
    "html/favicon/missing": [{ html: { head: { links: [{ rel: "apple-touch-icon", href: "/a.png" }] } } }],
    "html/hreflang-x-default/missing": [{ html: { hreflang: [{ lang: "en", href: "https://site.test/" }] } }],
    "html/jsonld/invalid": [{ html: { jsonld: [{ "@error": "Unexpected token" }] } }],
    "html/script/blocking": [{ html: { scripts: [{ src: "https://site.test/a.js", async: false, defer: false, head: true }] } }],
    "html/img-dimensions/missing": [{ html: { images: [{ src: "/a.png", alt: "" }] } }],
    "html/first-image/slow": [{ html: { images: [{ src: "/hero.png", alt: "", loading: "LAZY" }] } }],
    "html/privacy-policy/missing": [{ html: { rels: {} } }, { html: { rels: { "privacy-policy": [] } } }],
    "url/path/invalid": [{ pathname: "/Posts/" }, { pathname: "/posts/hello_world/" }, { pathname: "/posts//x/" }],
    "resources/a11y-overlay/present": [{ resources: ["https://acsbapp.com/apps/app/dist/js/app.js"] }, { resources: ["https://cdn.userway.org/widget.js"] }],
    "browser/preload/unused": [{ warnings: ["The resource https://site.test/a.woff2 was preloaded using link preload but not used within a few seconds from the window’s load event."] }],
    "redirects/status/temporary": [
        {
            redirects: [
                { url: "https://site.test/a", status: 301 },
                { url: "https://site.test/b", status: 302 },
            ],
        },
        { redirects: [{ url: "https://site.test/b", status: 307 }] },
    ],
    "redirects/redirect-by/missing": [
        {
            redirects: [
                { url: "https://site.test/a", status: 301, by: "WordPress" },
                { url: "https://site.test/b", status: 301 },
            ],
        },
    ],
    "http/coep/weak": [{ headers: { "cross-origin-embedder-policy": "unsafe-none" } }],
    "http/digest/missing": [{ headers: { "repr-digest": undefined as unknown as string } }],
    "http/server-timing/missing": [
        { role: "development", headers: { "server-timing": "" } },
        { role: "staging", headers: { "server-timing": "" } },
    ],
    "html/noai/present": [
        { stance: { "ai-train": "yes" }, meta: { robots: "noai" } },
        { stance: { "ai-train": "yes" }, headers: { "x-robots-tag": "noimageai" } },
    ],
    "html/noindex-staging/missing": [{ role: "staging" }, { role: "development", meta: { robots: "nofollow" } }],
    "http/no-vary-search/missing": [{ search: "?utm_source=x" }],
    "http/link/invalid": [{ headers: { link: "https://site.test/a.css; rel=preload" } }, { headers: { link: "<https://site.test/a.css>" } }, { headers: { link: '<https://site.test/a.css>; rel=preload; as="style' } }],
    "http/use-as-dictionary-match/invalid": [{ headers: { "use-as-dictionary": 'id="v1"' } }],
    "http/tdm-reservation/invalid": [{ headers: { "tdm-reservation": "yes" } }],
    "html/tdm-reservation/invalid": [{ meta: { "tdm-reservation": "2" } }],
    "html/speculation-rules/missing": [{ html: { scripts: [] } }],
    "html/feed-link/missing": [{ pathname: "/" }, { pathname: "/", html: { head: { links: [{ rel: "alternate", type: "text/markdown", href: "https://site.test/index.md" }] } } }],
    "html/alternate-format/missing": [{ pathname: "/" }, { pathname: "/", html: { head: { links: [{ rel: "alternate", type: "text/html", hreflang: "es", href: "https://site.test/es/" }] } } }],
    "html/nlweb/missing": [{ pathname: "/" }],
    "html/noindex-twin/missing": [{ twin: "https://prod.test/posts/hello-world/" }],
    "tls/certificate/expiring": [{ daysLeft: 13 }, { daysLeft: 2 }, { daysLeft: 1 }, { daysLeft: 0 }],
    "tls/certificate/expired": [{ daysLeft: -1 }],
    "tls/key/weak": [{ cert: { key: { type: "RSA", bits: 1024 } } }, { cert: { key: { type: "EC", curve: "P-192" } } }, { cert: { key: { type: "DSA" } } }],
    "tls/signature/weak": [{ cert: { signatures: ["sha256WithRSAEncryption", "sha1WithRSAEncryption"] } }, { cert: { signatures: ["md5WithRSAEncryption"] } }, { cert: { signatures: ["ecdsa-with-SHA1"] } }],
    "tls/ec-key/missing": [{ cert: { key: { type: "RSA", bits: 2048 } } }],
    "html/stylesheet/blocking": [
        {
            html: {
                head: {
                    links: [
                        { rel: "stylesheet", href: "https://site.test/a.css" },
                        { rel: "Stylesheet", media: "screen", href: "https://site.test/b.css" },
                    ],
                },
            },
        },
    ],
    "html/lang/missing": [{ html: { lang: undefined } }],
    "html/viewport/missing": [{ meta: { viewport: undefined as unknown as string } }],
    "html/color-scheme/missing": [{ meta: { "color-scheme": undefined as unknown as string } }],
    "html/charset/missing": [{ html: { charset: undefined } }],
    "html/h1/missing": [{ html: { h1: [] } }],
    "html/canonical/missing": [{ html: { canonical: undefined } }],
    "html/og-title/missing": [{ html: { property: {} } }],
    "html/og-description/missing": [{ html: { property: {} } }],
    "html/og-image/missing": [{ html: { property: {} } }],
    "html/og-type/missing": [{ html: { property: {} } }],
    "html/og-url/missing": [{ html: { property: {} } }],
    "html/fediverse-creator/missing": [{ meta: { "fediverse:creator": undefined as unknown as string } }],
    "http/compression/missing": [{ headers: { "content-encoding": undefined as unknown as string } }],
    "http/content-type-options/missing": [{ headers: { "x-content-type-options": undefined as unknown as string } }],
    "http/corp/missing": [{ headers: { "cross-origin-resource-policy": undefined as unknown as string } }],
    "http/date/missing": [{ headers: { date: undefined as unknown as string } }],
    "http/hsts/missing": [{ headers: { "strict-transport-security": undefined as unknown as string } }],
    "http/referrer-policy/missing": [{ headers: { "referrer-policy": undefined as unknown as string } }],
    "http/coop/missing": [{ headers: { "cross-origin-opener-policy": undefined as unknown as string } }],
    "http/coep/missing": [{ headers: { "cross-origin-embedder-policy": undefined as unknown as string } }],
    "html/h1/duplicate": [{ html: { h1: ["Hello", "Again"] } }],
};

// Pages the rule must pass or skip, beyond the bare `page()`.
const PASSES: Record<string, Patch[]> = {
    "url/uppercase/present": [{ pathname: "/posts/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82/" }],
    "url/session-param/present": [{ search: "?side=left" }],
    "url/extension/present": [{ pathname: "/feed.xml" }],
    "url/slug/unreadable": [{ pathname: "/" }, { pathname: "/p/%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82-%D0%BC%D0%B8%D1%80/", html: { h1: ["Привет, мир"] } }, { pathname: "/privet/", html: { h1: ["Привет"] } }, { pathname: "/strasse.html", html: { h1: ["Die Straße"] } }],
    "http/csp/missing": [{ headers: { "content-security-policy": undefined as unknown as string }, html: { "http-equiv": [{ name: "content-security-policy", content: "default-src 'self'" }] } }],
    "http/csp-unsafe-inline/present": [{ headers: { "content-security-policy": "script-src 'nonce-r4nd0m' 'unsafe-inline'" } }, { headers: { "content-security-policy": "script-src 'self' 'unsafe-inline', script-src 'self'" } }, { headers: { "content-security-policy": "style-src 'unsafe-inline'; script-src 'self'" } }],
    "http/csp-unsafe-eval/present": [{ headers: { "content-security-policy": "script-src 'self' 'unsafe-eval'" }, html: { "http-equiv": [{ name: "content-security-policy", content: "default-src 'self'" }] } }],
    "http/csp-script-src/insecure": [{ headers: { "content-security-policy": "script-src 'nonce-r4nd0m' 'strict-dynamic' https:" } }, { headers: { "content-security-policy": "default-src *, script-src 'self'" } }],
    "http/csp-object-src/weak": [{ headers: { "content-security-policy": "default-src 'none'" } }, { headers: { "content-security-policy": "default-src 'self', object-src 'none'" } }],
    "redirects/status/temporary": [
        {
            redirects: [
                { url: "https://site.test/a", status: 301 },
                { url: "https://site.test/b", status: 308 },
            ],
        },
        { status: 404, redirects: [{ url: "https://site.test/b", status: 302 }] },
    ],
    "http/referrer-policy/insecure": [{ headers: { "referrer-policy": undefined as unknown as string } }, { headers: { "referrer-policy": "unsafe-url, no-referrer" } }],
    "http/x-xss-protection/insecure": [{ headers: { "x-xss-protection": "0" } }],
    "http/header/deprecated": [{ headers: { "report-to": '{"group":"network-errors"}', nel: '{"report_to":"network-errors","max_age":86400}' } }],
    "links/internal-nofollow/present": [{ html: { links: { internal: [], external: ["https://other.test/"], nofollow: ["https://other.test/"] } } }],
    "http/compression/weak": [{ headers: { "content-encoding": undefined as unknown as string } }, { decoded: 512, headers: { "content-encoding": "identity" } }, { contentType: "image/png", headers: { "content-encoding": "identity" } }],
    "http/validator/missing": [{ headers: { etag: undefined as unknown as string, "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" } }],
    "http/no-store/present": [{ contentType: "application/json", headers: { "cache-control": "no-store" } }],
    "http/retry-after/missing": [
        { status: 503, headers: { "retry-after": "120" } },
        { status: 503, headers: { "retry-after": "Fri, 01 Jan 2027 00:00:00 GMT" } },
        { status: 503, headers: { "retry-after": "2m" } },
    ],
    "http/retry-after/weak": [
        { status: 503, headers: { "retry-after": "120" } },
        { status: 429, headers: { "retry-after": "Sun, 06 Nov 1994 08:59:37 GMT" } },
        { status: 301, headers: { "retry-after": "1" } },
        { status: 503, headers: { "retry-after": "Sun, 06 Nov 1994 08:49:30 GMT", date: undefined as unknown as string } },
    ],
    "http/retry-after/invalid": [{ headers: { "retry-after": "0" } }, { headers: { "retry-after": "Fri, 01 Jan 2027 00:00:00 GMT" } }],
    "http/sunset/invalid": [{ headers: { sunset: "Fri, 01 Jan 2027 00:00:00 GMT" } }],
    "http/deprecation/invalid": [{ headers: { deprecation: "@1767225600" } }],
    "html/lang/invalid": [{ html: { lang: undefined } }, { lang: "zh-Hant-TW" }, { lang: "es-419" }],
    "html/viewport/inaccessible": [{ meta: { viewport: undefined as unknown as string } }, { meta: { viewport: "width=device-width, maximum-scale=1.5" } }],
    "html/theme-color-dark/missing": [
        { meta: { "color-scheme": "light" }, html: { metas: [{ name: "theme-color", content: "#fff" }] } },
        {
            html: {
                metas: [
                    { name: "theme-color", content: "#fff" },
                    { name: "theme-color", content: "#000", media: "(prefers-color-scheme: dark)" },
                ],
            },
        },
    ],
    "http/server-timing/missing": [{ headers: { "server-timing": "" } }],
    "html/noai/present": [{ meta: { robots: "noai" } }, { stance: { "ai-train": "no" }, meta: { robots: "noai" } }, { stance: { "ai-train": "yes" } }],
    "html/noindex-staging/missing": [
        { role: "staging", meta: { robots: "noindex" } },
        { role: "staging", twin: "https://prod.test/posts/hello-world/" },
    ],
    "html/noindex/mismatch": [{ meta: { robots: "noindex" }, role: "staging" }, { meta: { robots: "noindex" }, listed: false }, { meta: { robots: "noindex" }, twin: "https://prod.test/posts/hello-world/" }, { meta: { robots: "max-image-preview:large" } }, { headers: { "x-robots-tag": "nofollow" } }],
    "html/dir/missing": [{ lang: "ar-EG", html: { dir: "rtl" } }, { lang: "arn" }],
    "html/charset/invalid": [{ html: { charset: undefined } }, { html: { charset: { declared: "utf8", offset: 1024 } } }],
    "html/favicon/missing": [{ html: { head: { links: [{ rel: "shortcut icon", href: "/favicon.ico" }] } } }],
    "html/hreflang-x-default/missing": [
        {
            html: {
                hreflang: [
                    { lang: "en", href: "https://site.test/" },
                    { lang: "x-default", href: "https://site.test/" },
                ],
            },
        },
    ],
    "html/jsonld/invalid": [{ html: { jsonld: [[{ "@type": "Thing" }, { "@type": "Place" }, { "@type": "Person" }]] } }],
    "html/script/blocking": [
        {
            html: {
                scripts: [
                    { src: "https://site.test/a.js", async: false, defer: true, head: true },
                    { src: "https://site.test/b.js", async: false, defer: false, head: false },
                    { async: false, defer: false, head: true },
                ],
            },
        },
    ],
    "html/img-dimensions/missing": [{ html: { images: [{ src: "/pixel.gif", alt: "", noscript: true }] } }],
    "html/first-image/slow": [
        { html: { images: [] } },
        {
            html: {
                images: [
                    { src: "/hero.png", alt: "", loading: "eager" },
                    { src: "/below.png", alt: "", loading: "lazy" },
                ],
            },
        },
    ],
    "url/path/invalid": [{ pathname: "/es/ma%C3%B1ana/" }],
    "redirects/redirect-by/missing": [{ redirects: [{ url: "https://site.test/a", status: 301, by: "WordPress" }] }],
    "http/coep/weak": [{ headers: { "cross-origin-embedder-policy": undefined as unknown as string } }, { headers: { "cross-origin-embedder-policy": 'require-corp; report-to="default"' } }],
    "http/permissions-policy/invalid": [{ headers: { "permissions-policy": 'geolocation=(self "https://maps.test"), fullscreen=*' } }],
    "http/csp/invalid": [{ headers: { "content-security-policy": "script-src 'nonce-r4nd0m' 'strict-dynamic' https: *.cdn.test:443/js/; img-src data: 'self'" } }],
    "http/cache-control/invalid": [{ headers: { "cache-control": 'private="set-cookie", no-cache, max-age="0"' } }],
    "http/priority/invalid": [{ headers: { priority: "u=1, i" } }],
    "http/cache-status/invalid": [{ headers: { "cache-status": "ExampleCache; hit; ttl=30" } }],
    "http/digest/missing": [{ headers: { "repr-digest": undefined as unknown as string, "content-digest": "sha-256=:x:" } }],
    "http/no-vary-search/missing": [{ search: "?q=1", headers: { "no-vary-search": "params" } }],
    "http/link/invalid": [{ headers: { link: "<https://site.test/a.css>; rel=preload; as=style, <https://site.test/b.js>; rel=modulepreload" } }, { headers: { link: '<https://site.test/a,b.css>; rel="preload prefetch"; title="x, y"; crossorigin' } }],
    "http/alt-svc-h3/missing": [{ headers: { "alt-svc": 'h2=":443", h3="cdn.test:443"; ma=86400; persist=1' } }],
    "http/alt-svc/invalid": [{ headers: { "alt-svc": "clear" } }, { headers: { "alt-svc": 'h3="[::1]:443"; foo=bar' } }],
    "html/color-scheme/invalid": [{ meta: { "color-scheme": undefined as unknown as string } }, { meta: { "color-scheme": "normal" } }, { meta: { "color-scheme": "only light" } }, { meta: { "color-scheme": "dark light only" } }],
    "html/viewport/invalid": [{ meta: { viewport: "width = device-width; initial-scale=1.0 viewport-fit=cover, interactive-widget=resizes-content" } }],
    "html/theme-color/invalid": [
        {
            html: {
                metas: [
                    { name: "theme-color", content: "oklch(70% 0.1 200)" },
                    { name: "theme-color", content: "RebeccaPurple", media: "(prefers-color-scheme: dark)" },
                ],
            },
        },
    ],
    "html/og-image/invalid": [{ html: { property: {} } }, { html: { property: { "og:image": "https://site.test/og.png" } } }],
    "html/og-type/invalid": [{ html: { property: {} } }, { html: { property: { "og:type": "music.song" } } }, { html: { property: { "og:type": "fb:app" } } }],
    "http/use-as-dictionary-match/invalid": [{ headers: { "use-as-dictionary": 'match="/app-*.js", id="v1"' } }],
    "http/tdm-reservation/invalid": [{ headers: { "tdm-reservation": "1" } }],
    "html/tdm-reservation/invalid": [{ meta: { "tdm-reservation": "0" } }],
    "html/speculation-rules/missing": [{ html: { scripts: [] }, headers: { "speculation-rules": '"/rules.json"' } }],
    "html/feed-link/missing": [{ pathname: "/", html: { head: { links: [{ rel: "alternate", type: "application/atom+xml", href: "https://site.test/feed.xml" }] } } }],
    "html/alternate-format/missing": [{ pathname: "/", html: { head: { links: [{ rel: "alternate", type: "text/markdown", href: "https://site.test/index.md" }] } } }],
    "html/nlweb/missing": [{ pathname: "/", html: { rels: { nlweb: ["https://site.test/ask"] } } }],
    "html/noindex-twin/missing": [{ twin: "https://prod.test/posts/hello-world/", meta: { robots: "noindex" } }],
    "tls/certificate/expiring": [{ daysLeft: 14 }, { daysLeft: -1 }],
    "tls/certificate/expired": [{ daysLeft: 0 }, { daysLeft: 13 }],
    "tls/key/weak": [{ cert: { key: { type: "RSA", bits: 4096 } } }, { cert: { key: { type: "Ed25519" } } }, { cert: { key: undefined } }],
    "tls/signature/weak": [{ cert: { signatures: undefined } }],
    "html/stylesheet/blocking": [
        {
            html: {
                head: {
                    links: [
                        { rel: "stylesheet", href: "https://site.test/a.css" },
                        { rel: "stylesheet", media: "print", href: "https://site.test/p.css" },
                        { rel: "alternate stylesheet", href: "https://site.test/c.css" },
                    ],
                },
            },
        },
    ],
    "html/h1/duplicate": [{ html: { h1: [] } }],
    "html/canonical/invalid": [{ html: { canonical: undefined } }],
    "html/og-title/length": [{ html: { property: {} } }],
    "html/og-description/length": [{ html: { property: {} } }],
    "html/og-url/invalid": [{ html: { property: {} } }],
    "html/fediverse-creator/invalid": [{ meta: { "fediverse:creator": undefined as unknown as string } }],
    "http/content-type-options/invalid": [{ headers: { "x-content-type-options": undefined as unknown as string } }],
    "http/corp/invalid": [{ headers: { "cross-origin-resource-policy": undefined as unknown as string } }],
    "http/date/invalid": [{ headers: { date: undefined as unknown as string } }],
    "http/hsts/weak": [{ headers: { "strict-transport-security": undefined as unknown as string } }],
    "http/coop/weak": [{ headers: { "cross-origin-opener-policy": undefined as unknown as string } }],
};

const specs = resolveRuleset("spiderlint:all", {});
const check = (id: string, patch: Patch) => (compileRule(id, specs[id] ?? {}) as PageRule).check(page(patch), { sitemaps: [], role: patch.role ?? "production", ...(patch.stance && { "content-signals": patch.stance }) }) ?? [];

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

    it("lets a rule glob’s star cross a slash", () => {
        assert.ok(isRuleMatch("html/og-title/length", "html/*"));
        assert.ok(isRuleMatch("html/og-title/length", "html/og-*"));
        assert.ok(isRuleMatch("html/og-title/length", "html/*/length"));
        assert.ok(!isRuleMatch("html/og-title/length", "http/*"));
        assert.ok(!isRuleMatch("html/og-title/length", "html/og-title/missing"));
    });

    it("reads a name no ruleset carries as a rule ID or glob", () => {
        assert.deepEqual(Object.keys(resolveRuleset("http/alt-svc-h3/missing", {})), ["http/alt-svc-h3/missing"]);
        assert.equal(resolveRuleset("http/alt-svc-h3/missing", {})["http/alt-svc-h3/missing"]?.severity, "warning");
        assert.ok(Object.keys(resolveRuleset("tls/*", {})).every((id) => id.startsWith("tls/")));
        assert.deepEqual(Object.keys(resolveRuleset("mine", { mine: { extends: ["http/alt-svc-h3/missing"] } })), ["http/alt-svc-h3/missing"]);
        assert.throws(() => resolveRuleset("http/no-such-rule", {}), /no rule ID matches it/);
    });

    it("ships every web preset the form offers, over HTTP only", () => {
        for (const name of Object.keys(WEB_PRESETS)) {
            const rules = compileRulesets([name], {});
            assert.ok(rules.length > 0, name);
            assert.deepEqual(
                rules.filter((rule) => rule.meta.facts.some((fact) => isBrowserFact(fact))).map((rule) => rule.meta.id),
                [],
                name,
            );
        }
        const quick = new Set(compileRulesets(["web-quick"], {}).map((rule) => rule.meta.id));
        assert.ok(!quick.has("links/external/unreachable") && quick.has("links/internal/unreachable"), "no outbound probe of external links");
        assert.ok(compileRulesets(["web-comprehensive"], {}).length > compileRulesets(["recommended"], {}).length);
    });

    it("derives server from the recommended rules that need no page past the seeds", () => {
        const server = resolveRuleset("server", {});
        assert.ok(presetNames().includes("server"));
        assert.ok(Object.hasOwn(server, "robots/root/blocked"));
        assert.ok(Object.hasOwn(server, "dns/caa/missing"));
        assert.ok(!Object.hasOwn(server, "http/compression/weak"), "a page rule");
        assert.ok(!Object.hasOwn(server, "dns/cname/insecure"), "a linked rule");
        assert.ok(!Object.hasOwn(server, "links/rel-me-backlink/missing"), "its extractor reads every crawled page");
    });

    it("lists performance, and recommended extends it", () => {
        assert.ok(presetNames().includes("performance"));
        assert.ok(Object.hasOwn(resolveRuleset("spiderlint:recommended", {}), "http/compression/weak"));
        assert.ok(!Object.hasOwn(resolveRuleset("spiderlint:recommended", {}), "http/digest/missing"));
        assert.equal(resolveRuleset("spiderlint:recommended", {})["insight/number/outlier"]?.severity, "info");
    });

    it("keeps the offending value in data for a header rule", () => {
        const [finding] = check("http/referrer-policy/insecure", { headers: { "referrer-policy": "unsafe-url" } });
        assert.equal(finding?.text, "Referrer-Policy should not leak full URLs");
        assert.deepEqual(finding?.variables, { field: "value" });
        assert.equal(finding?.message, "Referrer-Policy should not leak full URLs");
        assert.deepEqual(finding?.data, { "https://site.test/posts/hello-world/": { got: "10 characters: “unsafe-url”" } });
    });

    it("keeps a measured value out of the sentence, in the data of each URL", () => {
        const rule = compileRule("test/measured", { fact: "html.title", expect: { type: "string", minLength: 30 }, message: "title is short", severity: "warning" }) as PageRule;
        const [first, second] = ["Short", "Tiny"].map((html_title) => (rule.check(page({ html: { title: html_title } }), { sitemaps: [], role: "production" }) ?? [])[0] as Finding);
        assert.equal(first?.message, "title is short");
        assert.equal(first?.message, second?.message);
        assert.deepEqual(first?.data, { [first?.url as string]: { got: "5 characters: “Short”" } });
    });

    it("shows the value alone, with no length, when an exact value is expected", () => {
        const rule = compileRule("test/exact", { fact: "html.lang", expect: { const: "all" }, message: "got {got}", severity: "warning" }) as PageRule;
        const [finding] = rule.check(page({ lang: "some" }), { sitemaps: [], role: "production" }) ?? [];
        assert.equal(finding?.message, "got “some”");
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

// The paths of the pages a site rule's findings list.
function paths(findings: ReturnType<AggregateRule["check"]>): string[] {
    return (findings ?? []).flatMap((finding) => finding.urls ?? []).map((url) => new URL(url).pathname);
}

describe("url shape across pages", () => {
    it("names the pages joining words with the separator fewer pages use", () => {
        const rule = builtin["url/separator/inconsistent"]?.("warning") as AggregateRule;
        const pages = ["/a-b/", "/c-d/", "/e_f/", "/", "/g/"].map((pathname) => page({ pathname }));
        assert.deepEqual(paths(rule.check(pages)), ["/e_f/"]);
        assert.deepEqual(rule.check(["/a_b/", "/c_d/"].map((pathname) => page({ pathname }))), []);
    });

    it("names the pages of a group whose trailing slash breaks the group's usual form", () => {
        const rule = builtin["url/trailing-slash/inconsistent"]?.("warning") as AggregateRule;
        const pages = ["/a/", "/b/", "/c", "/", "/feed.xml", "/.well-known/api-catalog"].map((pathname) => page({ pathname }));
        const [finding, ...rest] = rule.check(pages) ?? [];
        assert.equal(rest.length, 0);
        assert.deepEqual(paths([finding as Finding]), ["/c"]);
        assert.match(finding?.message ?? "", /2 of 3 pages end with \/; the others differ/);
    });
});

const pageRules = Object.keys(specs)
    .filter((id) => specs[id]?.severity !== "off")
    .map((id) => compileRule(id, specs[id] ?? {}))
    .filter((rule): rule is PageRule => isPageRule(rule));
// Every page rule that fires on `facts`.
const fired = (facts: Facts) => pageRules.flatMap((rule) => rule.check(facts, { sitemaps: [], role: "production" }) ?? []).map((finding) => finding.rule);

describe("header grammar", () => {
    const cases: [string, string, string][] = [
        ["cache-control", "banana", "http/cache-control/invalid"],
        ["strict-transport-security", "max-age=abc", "http/hsts/invalid"],
        ["permissions-policy", "camera=(self", "http/permissions-policy/invalid"],
        ["retry-after", "2m", "http/retry-after/invalid"],
        ["alt-svc", "h3=:443", "http/alt-svc/invalid"],
        ["link", "<https://site.test/a.css>", "http/link/invalid"],
    ];
    for (const [name, value, id] of cases) {
        it(`${name}: ${value} is one syntax finding and no policy finding`, () => {
            const clean = new Set(fired(page()));
            assert.deepEqual(
                fired(page({ headers: { [name]: value } })).filter((rule) => !clean.has(rule)),
                [id],
            );
        });
    }
});

describe("content security policy", () => {
    it("judges document headers on documents only, and on a type the owner adds", () => {
        const bare = { headers: { "content-security-policy": undefined as unknown as string } };
        assert.equal(check("http/csp/missing", { ...bare, contentType: "text/markdown" }).length, 0);
        assert.equal(check("http/csp/missing", { ...bare, contentType: "application/json" }).length, 0);
        assert.equal(check("http/csp-base-uri/missing", { headers: { "content-security-policy": "default-src 'self'" }, contentType: "application/json" }).length, 0);
        assert.equal(check("http/csp/missing", { ...bare, contentType: "application/pdf" }).length, 1);
        assert.equal(check("http/csp/missing", bare).length, 1);
        const markdown = page({ ...bare, contentType: "text/markdown" });
        documentFacts([markdown], ["Text/Markdown"]);
        assert.equal((compileRule("http/csp/missing", specs["http/csp/missing"] ?? {}) as PageRule).check(markdown, { sitemaps: [], role: "production" })?.length, 1);
    });
    it("combines two headers and a meta as the browser enforces them", () => {
        const facts = page({ html: { "http-equiv": [{ name: "content-security-policy", content: "script-src 'self'; frame-ancestors 'none'" }] } });
        facts.http.headers["content-security-policy"] = ["default-src 'self' 'unsafe-eval' https://cdn.test", "script-src 'self' https://cdn.test 'unsafe-eval'; object-src 'none'"];
        facts.http.headers["content-security-policy-report-only"] = "default-src 'none'";
        assert.deepEqual(cspFacts(facts), { policies: 3, directives: { "default-src": ["'self'", "'unsafe-eval'", "https://cdn.test"], "script-src": ["'self'"], "object-src": [] }, "report-only": { policies: 1, directives: { "default-src": ["'none'"] } } });
    });
});
