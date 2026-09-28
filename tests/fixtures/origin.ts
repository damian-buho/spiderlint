// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

export interface Origin {
    origin: string;
    requested: string[];
    close(): Promise<void>;
}

const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Page</title></head><body><h1>Page</h1><p>${"Page text. ".repeat(100)}</p></body></html>`;
const TRACE = "Error: no route\n    at dispatch (/srv/app/router.js:42:11)\n";
const CROSS_DOMAIN = `<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>`;

// Names the `entry` kind answers, each pinned to the fixture’s address.
export const ENTRY_HOSTS = ["drop.test", "www.drop.test", "hops.test", "www.hops.test", "via.hops.test"];

// `soft`: every path answers 200 with an ETag it never honours, `/` redirects Japanese readers and offers gzip only, `/crossdomain.xml` grants every origin; `trace`: a missing path is a 404 stack trace, plain http redirects to https; `skew`: `Date` runs 10 minutes ahead, and `/cached` comes from a cache; `entry`: `www.drop.test` 302s to the apex root, `www.hops.test` 301s to the apex through `via.hops.test`.
export async function serveOrigin(kind: "soft" | "trace" | "skew" | "entry"): Promise<Origin> {
    const requested: string[] = [];
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://origin").pathname;
        const language = request.headers["accept-language"];
        requested.push(pathname);
        if (kind === "soft" && pathname === "/" && language?.startsWith("ja")) {
            response.writeHead(302, { location: "/ja/" });
            response.end();
            return;
        }
        const { hostname, port } = new URL(`http://${request.headers.host}`);
        const hop = ({ "www.drop.test": `http://drop.test:${port}/`, "www.hops.test": `http://via.hops.test:${port}${request.url}`, "via.hops.test": `http://hops.test:${port}${request.url}` } as Record<string, string>)[hostname];
        if (kind === "entry" && hop) {
            response.writeHead(hostname === "www.drop.test" ? 302 : 301, { location: hop });
            response.end();
            return;
        }
        if (kind === "soft" && pathname === "/crossdomain.xml") {
            response.writeHead(200, { "content-type": "text/x-cross-domain-policy" });
            response.end(CROSS_DOMAIN);
            return;
        }
        if (kind === "trace" && pathname === "/" && language === undefined) {
            response.writeHead(301, { location: `https://${new URL(`http://${request.headers.host}`).hostname}/` });
            response.end();
            return;
        }
        if (kind === "trace" && !["/", "/page"].includes(pathname)) {
            response.writeHead(404, { "content-type": "text/plain", server: "Apache/2.4.58 (Ubuntu)" });
            response.end(TRACE);
            return;
        }
        if (kind === "skew") {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", date: new Date(Date.now() + 600_000).toUTCString(), ...(pathname === "/cached" && { age: "120" }) });
            response.end(PAGE);
            return;
        }
        const isGzip = kind === "soft" && pathname === "/" && String(request.headers["accept-encoding"] ?? "").includes("gzip");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...(kind === "soft" && { etag: '"soft"' }), ...(isGzip && { "content-encoding": "gzip", vary: "Accept-Encoding" }) });
        response.end(isGzip ? gzipSync(PAGE) : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requested,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
