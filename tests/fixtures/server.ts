// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

export interface Fixture {
    origin: string;
    requested: string[];
    headers: IncomingHttpHeaders[];
    close(): Promise<void>;
}

const SITE = new URL("site/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", txt: "text/plain", xml: "application/xml" };


// Size of `/big.bin`, a binary no crawl should download.
const BIG = 50_000_000;

// Response headers a page sends beyond content-type.
const HEADERS: Record<string, Record<string, string>> = {
    "/about": { "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "x-robots-tag": "nofollow" },
    "/posts/1": { "x-frame-options": "DENY" },
    "/orphan": { "set-cookie": "session=s3cr3t; Path=/; HttpOnly; SameSite=Lax" },
};

// `/x` resolves to `x.html`, then `x/index.html`; anything else is an HTML 404.
async function body(pathname: string, origin: string): Promise<[string, Buffer] | undefined> {
    const bare = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
    const candidates = /\.\w+$/.test(bare) ? [bare] : [`${bare}.html`, `${bare}/index.html`];
    for (const candidate of candidates) {
        try {
            const type = TYPES[candidate.split(".").pop() as string] ?? "application/octet-stream";
            const raw = await readFile(new URL(candidate.slice(1), SITE));
            // eslint-disable-next-line unicorn/prefer-https -- fixture.test mirrors the plain-http origin the fixture server runs on
            const placeholder = "http://fixture.test";
            const cdn = origin.replace("//127.0.0.1:", "//localhost:");
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

// Serves tests/fixtures/site on an ephemeral loopback port, `x.gz` as gzipped `x`, a matching `If-None-Match` as 304, and records every path asked for; `builtFor` bakes pages for another origin.
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
        if (pathname === "/forbidden") {
            response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
            response.end("<!DOCTYPE html><html lang=\"en\"><head><title>403</title></head><body><h1>Forbidden</h1></body></html>");
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
        const found = await body(isGzip ? pathname.slice(0, -3) : pathname, builtFor ?? `http://${request.headers.host}`);
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
        response.writeHead(200, { "content-type": isGzip ? "application/gzip" : found[0], etag, server, ...HEADERS[pathname] });
        response.end(isGzip ? gzipSync(found[1]) : found[1]);
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
