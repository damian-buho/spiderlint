// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

export interface Fixture {
    origin: string;
    requested: string[];
    close(): Promise<void>;
}

const SITE = new URL("site/", import.meta.url);
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", txt: "text/plain", xml: "application/xml" };


// Response headers a page sends beyond content-type.
const HEADERS: Record<string, Record<string, string>> = {
    "/about": { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
    "/posts/1": { "x-frame-options": "DENY" },
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
            return [type, Buffer.from(raw.toString("utf8").replaceAll(placeholder, () => origin))]; // Every file names the site as `fixture.test`; the real origin replaces it.
        } catch {
            continue;
        }
    }
    return undefined;
}

// Serves tests/fixtures/site on an ephemeral loopback port and records every path asked for.
export async function serveFixture(): Promise<Fixture> {
    const requested: string[] = [];
    const server: Server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
        requested.push(pathname);
        const found = await body(pathname, `http://${request.headers.host}`);
        if (!found) {
            response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
            response.end("<!DOCTYPE html><html lang=\"en\"><head><title>404</title><link rel=\"canonical\" href=\"/\"></head><body><h1>Not found</h1></body></html>");
            return;
        }
        response.writeHead(200, { "content-type": found[0], ...HEADERS[pathname] });
        response.end(found[1]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requested,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
