// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { audit } from "../src/index.ts";

describe("audit", () => {
    let server: Server;
    let origin: string;

    before(async () => {
        const page = await readFile(new URL("fixtures/index.html", import.meta.url));
        server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.end(page);
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("fetches one page and extracts html facts", async () => {
        const report = await audit({ seeds: [`${origin}/`], robots: false });
        assert.equal(report.pages.length, 1);
        const [page] = report.pages;
        assert.equal(page?.http.status, 200);
        assert.equal(page?.html?.title, "Fixture page");
        assert.deepEqual(page?.html?.h1, ["Fixture"]);
        assert.equal(page?.html?.meta.description, "A page the skeleton test serves locally");
        assert.equal(page?.group, "default");
        assert.equal(report.findings.length, 0);
    });
});
