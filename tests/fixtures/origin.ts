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

// `soft`: every path answers 200 with an ETag it never honours, `/` redirects Japanese readers and offers gzip only; `trace`: a missing path is a 404 stack trace, plain http redirects to https.
export async function serveOrigin(kind: "soft" | "trace"): Promise<Origin> {
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
