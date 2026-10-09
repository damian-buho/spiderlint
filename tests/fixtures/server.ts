// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { ico, png, SVG } from "./icons.ts";

export interface Fixture {
    origin: string;
    requested: string[];
    headers: IncomingHttpHeaders[];
    close(): Promise<void>;
}

const SITE = new URL("site/", import.meta.url);
// The favicon, SVG icon and Apple touch icon every page’s origin serves.
const ICONS: Record<string, [string, Buffer | string]> = { "/favicon.ico": ["image/x-icon", await ico([16, 32])], "/favicon.svg": ["image/svg+xml", SVG], "/apple-touch-icon.png": ["image/png", await png(180)] };
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css", txt: "text/plain", xml: "application/xml", webmanifest: "application/manifest+json" };

// Size of `/big.bin`, a binary no crawl should download.
const BIG = 50_000_000;

// Response headers a page sends beyond content-type.
const HEADERS: Record<string, Record<string, string | string[]>> = {
    "/about": { "content-security-policy": "default-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'", "x-robots-tag": "nofollow" },
    "/posts/1": { "x-frame-options": "DENY" },
    "/orphan": { "set-cookie": ["session=s3cr3t; Path=/; HttpOnly; SameSite=Lax", "__Host-id=1; Secure; Path=/; HttpOnly; SameSite=Strict"] },
};

// Pages answering a 103 first: the preloads it hints, then the `Link` the final response keeps.
const HINTED: Record<string, [string[], string]> = {
    "/hints": [["</style.css>; rel=preload; as=style", "</font.woff2>; rel=preload; as=font"], "</style.css>; rel=preload; as=style"],
    "/hints-ok": [["</style.css>; rel=preload; as=style"], "</style.css>; rel=preload; as=style"],
};

// Pages the live checks walk: every defect, its clean twin, and a script that skips a button; THIRD is a third-party pixel.
const LIVE: Record<string, string> = {
    "/live-bad": `<!doctype html><html lang="en"><head><title>Live bad</title><meta name="color-scheme" content="light dark"><style>
main p { color: #333 }
header { position: sticky; top: 0; height: 200px; background: #fff; z-index: 1 }
header a:focus { outline: none }
.banner { position: fixed; top: 300px; bottom: 0; left: 0; right: 0; background: #eee }
.spin { animation: spin 1s linear infinite }
@keyframes spin { to { transform: rotate(360deg) } }
input { font-size: 12px }
#ring:focus { outline: none; box-shadow: 0 0 0 3px blue }
.grad { background: linear-gradient(#000, #333); width: 24px; height: 24px }
.mask { mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24'/%3E%3C/svg%3E"); background-color: currentColor; width: 24px; height: 24px }
@media (prefers-contrast: more) { main p { color: #666 } }
</style></head><body>
<header><a href="/about">About</a></header>
<main><p>Welcome</p><div class="spin">Loading</div><div id="open">Open</div><input aria-label="Name"><div style="height: 2000px"></div><a href="/posts/1">Post</a>
<button id="ring">Ring</button><button class="grad" aria-label="Menu"></button><button class="mask" aria-label="Search"></button><p style="forced-color-adjust: none">Kept</p>
<button id="a">A</button><button id="b">B</button></main>
<div class="banner">We value your privacy</div>
<img src="THIRD" alt="" width="1" height="1">
<script>
document.getElementById("open").addEventListener("click", () => {});
document.getElementById("b").addEventListener("keydown", (event) => { if (event.key === "Tab") { event.preventDefault(); document.getElementById("a").focus(); } });
localStorage.setItem("visitor", "1");
</script></body></html>`,
    "/live-clean": `<!doctype html><html lang="en"><head><title>Live clean</title><meta name="color-scheme" content="light dark"><style>
main p { color: #333 }
@media (prefers-color-scheme: dark) { body { background: #111; color: #eee } main p { color: #ddd } }
@media (prefers-reduced-motion: no-preference) { .spin { animation: spin 1s linear infinite } }
@keyframes spin { to { transform: rotate(360deg) } }
input { font-size: 16px }
#ring:focus { outline: 2px solid transparent; box-shadow: 0 0 0 3px blue }
@media (prefers-contrast: more) { main p { color: #000 } }
</style></head><body>
<a href="#main">Skip to content</a><nav><a href="/about">About</a></nav>
<main id="main"><p>Welcome</p><div class="spin">Loading</div><button id="open">Open</button><button id="ring">Ring</button><button aria-label="Menu"><svg width="16" height="16" aria-hidden="true"><rect width="16" height="16" fill="currentColor"/></svg></button><input aria-label="Name"><a href="/posts/1">Post</a></main>
<script>document.getElementById("open").addEventListener("click", () => {});</script></body></html>`,
    "/live-skip": `<!doctype html><html lang="en"><head><title>Live skip</title></head><body>
<a href="#main">Skip to content</a><main id="main"><button id="x">X</button><button id="y">Y</button><button id="z">Z</button></main>
<script>document.getElementById("x").addEventListener("keydown", (event) => { if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); document.getElementById("z").focus(); } });</script></body></html>`,
};

// A theme-color pair a head script collapses to one tag, and its twin served with one tag only.
const THEMED: Record<string, string> = {
    "/theme-script":
        '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)"><script>for (const tag of document.querySelectorAll("meta[name=theme-color]")) tag.remove(); document.head.insertAdjacentHTML("beforeend", \'<meta name="theme-color" content="#ffffff">\');</script>',
    "/theme-single": '<meta name="theme-color" content="#ffffff">',
};

const PLAIN = '<!DOCTYPE html><html lang="en"><head><title>Plain</title></head><body><h1>Plain</h1></body></html>';

// `/x` resolves to `x.html`, then `x/index.html`; anything else is an HTML 404.
async function body(pathname: string, origin: string, local: string): Promise<[string, Buffer] | undefined> {
    const bare = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const candidates = /\.\w+$/.test(bare) ? [bare] : [`${bare}.html`, `${bare}/index.html`];
    for (const candidate of candidates) {
        try {
            const type = TYPES[candidate.split(".").pop() as string] ?? "application/octet-stream";
            const raw = await readFile(new URL(candidate.slice(1), SITE));
            // eslint-disable-next-line unicorn/prefer-https -- fixture.test mirrors the plain-http origin the fixture server runs on
            const placeholder = "http://fixture.test";
            const cdn = local.replace("//127.0.0.1:", "//localhost:");
            // eslint-disable-next-line unicorn/prefer-https -- the CDN placeholder mirrors the same plain-http server
            const cdnPlaceholder = "http://fixture-cdn.test";
            return [
                type,
                Buffer.from(
                    raw
                        .toString("utf8")
                        .replaceAll(placeholder, () => origin)
                        .replaceAll(cdnPlaceholder, () => cdn),
                ),
            ]; // `fixture.test` is the site, `fixture-cdn.test` the same server under another origin.
        } catch {
            continue;
        }
    }
    return undefined;
}

// Points the user cache at a temp directory unless the test chose one, so no run touches ~/.cache.
function isolateUserCache(): string | undefined {
    if (process.env.XDG_CACHE_HOME?.startsWith(tmpdir())) return undefined;
    process.env.XDG_CACHE_HOME = mkdtempSync(path.join(tmpdir(), "spiderlint-xdg-"));
    return process.env.XDG_CACHE_HOME;
}

// The coding `/` is sent in, the first of `br`, `zstd` and `gzip` a request accepts.
const CODINGS: [string, (body: Buffer) => Buffer][] = [
    ["br", brotliCompressSync],
    ["zstd", zstdCompressSync],
    ["gzip", gzipSync],
];

// Serves tests/fixtures/site on an ephemeral loopback port, `/` in the coding asked for, `x.gz` as gzipped `x`, a matching `If-None-Match` as 304, and records every path asked for; `builtFor` bakes pages for another origin.
export async function serveFixture(builtFor?: string): Promise<Fixture> {
    const userCache = isolateUserCache();
    const requested: string[] = [];
    const headers: IncomingHttpHeaders[] = [];
    const server: Server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
        requested.push(pathname);
        headers.push(request.headers);
        if (pathname === "/old-about") {
            response.writeHead(301, { location: "/about" });
            response.end();
            return;
        }
        if (pathname === "/i18n/sitemap.xml") {
            const origin = `http://${request.headers.host}`;
            const alternates = (...langs: string[]) => langs.map((lang) => `<xhtml:link rel="alternate" hreflang="${lang}" href="/i18n/${lang}"/>`).join("");
            response.writeHead(200, { "content-type": "application/xml" });
            response.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
<url><loc>${origin}/i18n/en</loc>${alternates("en", "es")}<image:image><image:loc>${origin}/i18n/missing.png</image:loc></image:image></url>
<url><loc>${origin}/i18n/es</loc>${alternates("es")}<image:image><image:loc>${origin}/favicon.ico</image:loc></image:image><video:video><video:content_loc>${origin}/favicon.ico</video:content_loc></video:video></url>
</urlset>`);
            return;
        }
        if (pathname === "/i18n/en" || pathname === "/i18n/es") {
            const lang = pathname.slice("/i18n/".length);
            const alternates = lang === "en" ? ["en", "es", "de"] : ["es"];
            const links = alternates.map((alternate) => `<link rel="alternate" hreflang="${alternate}" href="/i18n/${alternate}">`).join("");
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-language": "en" });
            response.end(`<!DOCTYPE html><html lang="${lang === "en" ? "en-GB" : lang}"><head><title>${lang}</title>${links}</head><body><h1>${lang}</h1></body></html>`);
            return;
        }
        if (pathname === "/moved") {
            response.writeHead(301, { location: "/moving" });
            response.end();
            return;
        }
        if (pathname === "/moving") {
            response.writeHead(302, { location: "/about", "x-redirect-by": "fixture" });
            response.end();
            return;
        }
        if (pathname === "/forbidden") {
            response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
            response.end('<!DOCTYPE html><html lang="en"><head><title>403</title></head><body><h1>Forbidden</h1></body></html>');
            return;
        }
        if (pathname === "/walled") {
            response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" });
            response.end('<!DOCTYPE html><html lang="en"><head><title>Just a moment…</title></head><body></body></html>');
            return;
        }
        if (pathname === "/edge-blocked") {
            response.writeHead(403, { "content-type": "text/html; charset=utf-8", "server-timing": "cfEdge;dur=14,cfOrigin;dur=0" });
            response.end('<!DOCTYPE html><html lang="en"><head><title>Forbidden</title></head><body></body></html>');
            return;
        }
        const hinted = HINTED[pathname];
        if (hinted) {
            response.writeEarlyHints({ link: hinted[0] });
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", link: hinted[1] });
            response.end(PLAIN);
            return;
        }
        if (pathname === "/cookies") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["__Host-bad=1; Secure; Path=/app; Domain=127.0.0.1", "__Host-ok=1; Secure; Path=/", "__secure-bad=1; Path=/", "cross=1; SameSite=none", "forever=1; Expires=Fri, 01 Jan 2100 00:00:00 GMT"] });
            response.end(PLAIN);
            return;
        }
        if (pathname === "/cookies-ok") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["__Secure-ok=1; Secure", "cross=1; Secure; SameSite=None", "short=1; Max-Age=3600; Expires=Fri, 01 Jan 2100 00:00:00 GMT", "session=1"] });
            response.end(PLAIN);
            return;
        }
        if (pathname === "/cookie-sources") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end('<!doctype html><html lang="en"><head><title>Cookie sources</title></head><body><img src="/cookie-pixel.gif" alt="" width="1" height="1"><script>document.cookie = "tracker=1; max-age=99999999"; document.cookie = "gone=; max-age=0"</script></body></html>');
            return;
        }
        if (pathname === "/consent-tracked" || pathname === "/consent-clean") {
            const third = `http://localhost:${new URL(`http://${request.headers.host}`).port}/third-party.gif`;
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": ["sid=1; Path=/; HttpOnly; SameSite=Lax"] });
            response.end(`<!doctype html><html lang="en"><head><title>Consent</title></head><body>${pathname === "/consent-tracked" ? `<img src="${third}" alt="" width="1" height="1">` : ""}</body></html>`);
            return;
        }
        if (pathname === "/preconnect-missing" || pathname === "/preconnect-font") {
            const cdn = `http://localhost:${new URL(`http://${request.headers.host}`).port}`;
            const head = pathname === "/preconnect-missing" ? `<script src="${cdn}/cdn/lib.js"></script>` : `<link rel="preconnect" href="${cdn}"><link rel="preload" href="${cdn}/font.woff2" as="font" type="font/woff2" crossorigin>`;
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(`<!doctype html><html lang="en"><head><title>Preconnect</title>${head}</head><body><h1>Preconnect</h1></body></html>`);
            return;
        }
        const live = LIVE[pathname];
        if (live) {
            const third = `http://localhost:${new URL(`http://${request.headers.host}`).port}/third-party.gif`;
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(live.replace("THIRD", () => third));
            return;
        }
        if (pathname === "/third-party.gif") {
            response.writeHead(200, { "content-type": "image/gif", "set-cookie": ["uid=1; Max-Age=600; SameSite=None; Secure"] });
            response.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
            return;
        }
        if (pathname === "/cookie-pixel.gif") {
            response.writeHead(200, { "content-type": "image/gif", "set-cookie": ["__Secure-px=1; Path=/; SameSite=Lax; HttpOnly"] });
            response.end(Buffer.from("R0lGODlhAQABAAAAACw=", "base64"));
            return;
        }
        const icon = ICONS[pathname];
        if (icon) {
            response.writeHead(200, { "content-type": icon[0] });
            response.end(icon[1]);
            return;
        }
        const themed = THEMED[pathname];
        if (themed !== undefined) {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(`<!DOCTYPE html><html lang="en"><head><title>Theme</title><meta name="color-scheme" content="light dark">${themed}</head><body><h1>Theme</h1></body></html>`);
            return;
        }
        if (pathname === "/down-page") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end('<!DOCTYPE html><html lang="en"><head><title>Down</title></head><body><h1>Down</h1><img src="/down.png" alt="" width="1" height="1"></body></html>');
            return;
        }
        if (pathname === "/down.png") {
            response.writeHead(503, { "content-type": "text/plain" });
            response.end("down");
            return;
        }
        if (pathname === "/data.json") {
            const etag = '"data"';
            const isUnchanged = request.headers["if-none-match"] === etag;
            response.writeHead(isUnchanged ? 304 : 200, { "content-type": "application/json", etag });
            response.end(isUnchanged ? undefined : '{"name": "fixture"}');
            return;
        }
        if (pathname === "/big.bin") {
            response.writeHead(200, { "content-type": "application/octet-stream", "content-length": BIG });
            response.end(Buffer.alloc(BIG));
            return;
        }
        const isGzip = pathname.endsWith(".gz");
        const local = `http://${request.headers.host}`;
        const found = await body(isGzip ? pathname.slice(0, -3) : pathname, builtFor ?? local, local);
        if (!found) {
            response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
            response.end('<!DOCTYPE html><html lang="en"><head><title>404</title><link rel="canonical" href="/"></head><body><h1>Not found</h1></body></html>');
            return;
        }
        const server = pathname.startsWith("/posts/") ? "fixture-b" : "fixture-a";
        const etag = `"${createHash("sha256").update(found[1]).digest("hex").slice(0, 16)}"`;
        if (request.headers["if-none-match"] === etag) {
            response.writeHead(304, { etag, server });
            response.end();
            return;
        }
        const coding = pathname === "/" ? CODINGS.find(([name]) => String(request.headers["accept-encoding"] ?? "").includes(name)) : undefined;
        const encoded = coding && { "content-encoding": coding[0], vary: "Accept-Encoding" };
        response.writeHead(200, { "content-type": isGzip ? "application/gzip" : found[0], etag, server, ...encoded, ...HEADERS[pathname] });
        response.end(isGzip ? gzipSync(found[1]) : coding ? coding[1](found[1]) : found[1]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requested,
        headers,
        close: async () => {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (userCache) await rm(userCache, { recursive: true, force: true });
        },
    };
}
