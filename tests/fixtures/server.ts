// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";
import type { AddressInfo } from "node:net";

export interface Fixture {
    origin: string;
    requested: string[];
    headers: IncomingHttpHeaders[];
    close(): Promise<void>;
}

const SITE = new URL("site/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", txt: "text/plain", xml: "application/xml", webmanifest: "application/manifest+json" };


// Size of `/big.bin`, a binary no crawl should download.
const BIG = 50_000_000;

// Response headers a page sends beyond content-type.
const HEADERS: Record<string, Record<string, string | string[]>> = {
    "/about": { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-robots-tag": "nofollow" },
    "/posts/1": { "x-frame-options": "DENY" },
    "/orphan": { "set-cookie": ["session=s3cr3t; Path=/; HttpOnly; SameSite=Lax", "__Host-id=1; Secure; Path=/; HttpOnly; SameSite=Strict"] },
};

// Pages answering a 103 first: the preloads it hints, then the `Link` the final response keeps.
const HINTED: Record<string, [string[], string]> = {
    "/hints": [["</style.css>; rel=preload; as=style", "</font.woff2>; rel=preload; as=font"], "</style.css>; rel=preload; as=style"],
    "/hints-ok": [["</style.css>; rel=preload; as=style"], "</style.css>; rel=preload; as=style"],
};

const PLAIN = "<!DOCTYPE html><html lang=\"en\"><head><title>Plain</title></head><body><h1>Plain</h1></body></html>";

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
            return [type, Buffer.from(raw.toString("utf8").replaceAll(placeholder, () => origin).replaceAll(cdnPlaceholder, () => cdn))]; // `fixture.test` is the site, `fixture-cdn.test` the same server under another origin.
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
const CODINGS: [string, (body: Buffer) => Buffer][] = [["br", brotliCompressSync], ["zstd", zstdCompressSync], ["gzip", gzipSync]];

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
            response.end("<!DOCTYPE html><html lang=\"en\"><head><title>403</title></head><body><h1>Forbidden</h1></body></html>");
            return;
        }
        if (pathname === "/walled") {
            response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" });
            response.end("<!DOCTYPE html><html lang=\"en\"><head><title>Just a moment…</title></head><body></body></html>");
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
        if (pathname === "/favicon.ico") {
            response.writeHead(200, { "content-type": "image/x-icon" });
            response.end(Buffer.from([0, 0, 1, 0]));
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
            response.end("<!DOCTYPE html><html lang=\"en\"><head><title>404</title><link rel=\"canonical\" href=\"/\"></head><body><h1>Not found</h1></body></html>");
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
