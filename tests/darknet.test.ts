// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { connect, createServer, type AddressInfo, type Server } from "node:net";
import { openBucket } from "../src/cache/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { fromSubtree } from "../src/config/policy.ts";
import { validateSubtree } from "../src/config/schema.ts";
import { darknetOf, isProxyDown, isProxyPage } from "../src/crawl/darknet.ts";
import { answerOf, isJudged, probeLinks } from "../src/crawl/links.ts";
import type { LinkFacts } from "../src/facts/types.ts";
import { admit } from "../src/server/policy.ts";
import { settingsOf } from "../src/server/settings.ts";

const PLAIN = "http:";
const ONION = `${PLAIN}//service.onion/page`;
const EEPSITE = `${PLAIN}//service.b32.i2p/page`;
const bucket = () => openBucket<LinkFacts>("probes", { cacheMode: "off", cacheTtl: {} }, undefined);
const signal = () => new AbortController().signal;
const portOf = (server: Server | HttpServer) => (server.address() as AddressInfo).port;
const config = (darknets: object) => ({ allowPrivate: false, linkExclude: [], concurrency: 2, vendorPaths: false, darknets });
const listen = async <T extends Server | HttpServer>(server: T) => new Promise<T>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));

// A SOCKS5 proxy that records each requested name, then relays to `target` or answers `reply`.
function socks(names: string[], reply: number, target?: () => number): Server {
    return createServer((socket) => {
        socket.on("error", () => socket.destroy());
        socket.once("data", () => {
            socket.write(Buffer.from([5, 0]));
            socket.once("data", (request: Buffer) => {
                names.push(request.subarray(5, 5 + (request[4] as number)).toString());
                const answer = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
                if (!target) return void socket.end(answer(reply));
                const upstream = connect(target(), "127.0.0.1", () => {
                    socket.write(answer(0));
                    upstream.pipe(socket);
                    socket.pipe(upstream);
                });
            });
        });
    });
}

describe("darknet networks", () => {
    it("names the network by the last label only", () => {
        assert.deepEqual(
            ["a.onion", "A.ONION.", "a.b32.i2p", "a.i2p", "onion", "i2p", "a.onion.example", "notonion", "example.com"].map((host) => darknetOf(host)),
            ["tor", "tor", "i2p", "i2p", undefined, undefined, undefined, undefined, undefined],
        );
    });

    it("tells a proxy that did not answer from a link it could not reach", () => {
        assert.deepEqual(
            ["connect ECONNREFUSED 127.0.0.1:9", "getaddrinfo ENOTFOUND proxy", "Socket closed", "Socks5 proxy rejected connection - HostUnreachable", "Proxy connection timed out"].map((error) => isProxyDown(error)),
            [true, true, true, false, false],
        );
    });

    it("recognises the I2P proxy’s page from status 500 up, and no site’s own answer", () => {
        const csp = { "content-security-policy": "default-src 'none'; style-src 'self' proxy.i2p" };
        assert.equal(isProxyPage(504, csp), true);
        assert.equal(isProxyPage(500, csp), true);
        assert.equal(isProxyPage(499, csp), false);
        assert.equal(isProxyPage(504, { "content-security-policy": "default-src 'self'" }), false);
        assert.equal(isProxyPage(504, {}), false);
    });
});

describe("darknet settings", () => {
    it("takes only proxies that resolve the name themselves", () => {
        for (const proxy of ["socks5h://127.0.0.1:9050", "socks4a://127.0.0.1:9050", "http://127.0.0.1:4444", "https://127.0.0.1:4444"]) assert.doesNotThrow(() => validateSubtree({ darknets: { tor: proxy } }), proxy);
        for (const proxy of ["socks5://127.0.0.1:9050", "socks4://127.0.0.1:9050", "socks://127.0.0.1:9050", "ftp://127.0.0.1"]) assert.throws(() => validateSubtree({ darknets: { i2p: proxy } }), ConfigError, proxy);
        assert.throws(() => validateSubtree({ darknets: { freenet: "http://127.0.0.1:1" } }), ConfigError);
    });

    it("reads the subtree into the run’s settings", () => {
        assert.deepEqual(fromSubtree({ darknets: { tor: "socks5h://127.0.0.1:9050" } }).darknets, { tor: "socks5h://127.0.0.1:9050" });
    });

    it("is set by the owner’s defaults and refused from a visitor", () => {
        const server = settingsOf({ defaults: { darknets: { tor: "socks5h://10.0.0.1:9050" } }, policies: [{ name: "all", hosts: ["*"] }] });
        assert.deepEqual(admit({ url: "https://example.com/" }, server).settings.darknets, { tor: "socks5h://10.0.0.1:9050" });
        assert.throws(() => admit({ url: "https://example.com/", settings: { darknets: { tor: "socks5h://attacker.test:9050" } } }, server), { code: "forbidden-setting" });
    });
});

describe("darknet links", () => {
    const names: string[] = [];
    let site: HttpServer;
    let relay: Server;
    let rejecting: Server;
    let proxy: HttpServer;
    const requested: string[] = [];

    before(async () => {
        site = await listen(createHttp((_request, response) => response.writeHead(200).end()));
        relay = await listen(socks(names, 0, () => portOf(site)));
        rejecting = await listen(socks(names, 4));
        proxy = await listen(
            createHttp((request, response) => {
                requested.push(request.url ?? "");
                if (request.url?.includes("dead")) return void response.writeHead(504, { "content-security-policy": "style-src proxy.i2p" }).end();
                response.writeHead(200).end();
            }),
        );
    });

    after(() => {
        for (const server of [site, relay, rejecting, proxy]) server.close();
    });

    it("never asks a network with no proxy, and never judges its links", async () => {
        const answers = await Promise.all([ONION, EEPSITE].map(async (href) => answerOf(href, config({}), bucket(), signal())));
        assert.deepEqual(answers, [
            { status: 0, excluded: true },
            { status: 0, excluded: true },
        ]);
        assert.equal(
            answers.some((answer) => isJudged(answer)),
            false,
        );
    });

    it("hands the name to the SOCKS proxy, past the address guard", async () => {
        names.length = 0;
        const { status } = await answerOf(ONION, config({ tor: `socks5h://127.0.0.1:${portOf(relay)}` }), bucket(), signal());
        assert.equal(status, 200);
        assert.deepEqual(names, ["service.onion"]);
    });

    it("asks through the HTTP proxy with the full URL, past the address guard", async () => {
        requested.length = 0;
        const { status } = await answerOf(EEPSITE, config({ i2p: `http://127.0.0.1:${portOf(proxy)}` }), bucket(), signal());
        assert.equal(status, 200);
        assert.deepEqual(requested, [EEPSITE]);
    });

    it("judges a service the proxy could not reach", async () => {
        const answer = await answerOf(`${PLAIN}//rejected.onion/`, config({ tor: `socks5h://127.0.0.1:${portOf(rejecting)}` }), bucket(), signal());
        assert.equal(answer.status, 0);
        assert.match(answer.error ?? "", /rejected connection/);
        assert.equal(isJudged(answer), true);
    });

    it("reads the I2P proxy’s error page as no answer", async () => {
        const answer = await answerOf(`${PLAIN}//dead.b32.i2p/`, config({ i2p: `http://127.0.0.1:${portOf(proxy)}` }), bucket(), signal());
        assert.deepEqual([answer.status, answer.error, isJudged(answer)], [0, "the proxy answers 504", true]);
    });

    it("never judges a link when the proxy itself is down", async () => {
        const closed = await listen(createServer());
        const port = portOf(closed);
        await new Promise((resolve) => closed.close(resolve));
        for (const darknets of [{ tor: `socks5h://127.0.0.1:${port}` }, { i2p: `http://127.0.0.1:${port}` }]) {
            const answer = await answerOf(darknets.tor ? `${PLAIN}//down.onion/` : `${PLAIN}//down.b32.i2p/`, config(darknets), bucket(), signal());
            assert.equal(answer.status, 0);
            assert.equal(isJudged(answer), false, JSON.stringify(answer));
        }
    });

    it("asks a silent host once, and its other links reuse the answer", async () => {
        names.length = 0;
        const links = ["a", "b", "c"].map((path) => `${PLAIN}//service.onion/${path}`);
        const answers = await probeLinks(links, config({ tor: `socks5h://127.0.0.1:${portOf(rejecting)}` }), bucket());
        assert.equal(Object.keys(answers).length, 3);
        assert.equal(new Set(Object.values(answers).map((answer) => answer.error)).size, 1);
        assert.equal(names.length, 2, "one link, asked twice by the retry");
    });
});
