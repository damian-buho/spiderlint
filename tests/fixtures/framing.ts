// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

const HOME = `<!DOCTYPE html><html lang="en"><head><title>Framing</title><script src="/short.js"></script><script src="/twice.js"></script><script src="/chunked.js"></script><script src="/long.js"></script><script src="/fine.js"></script></head><body><a href="/both">Both</a><a href="/empty">Empty</a><a href="/stale">Stale</a><a href="/short">Short</a><a href="/twice">Twice</a><a href="/long">Long</a></body></html>`;
const CODE = "void 0;";

// Raw responses by path, since Node’s own server refuses to frame a body wrongly.
const RESPONSES: Record<string, string> = {
    "/": `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${HOME.length}\r\n\r\n${HOME}`,
    "/both": `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 10\r\nTransfer-Encoding: chunked\r\n\r\na\r\n<p>both</p\r\n0\r\n\r\n`,
    "/empty": `HTTP/1.1 204 No Content\r\nContent-Length: 10\r\n\r\n`,
    "/stale": `HTTP/1.1 304 Not Modified\r\nContent-Length: 10\r\n\r\n`,
    "/short": `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 400\r\n\r\n<p>short</p>`,
    "/twice": `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 12\r\nContent-Length: 12\r\n\r\n<p>twice</p>`,
    "/long": `HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 4\r\n\r\n<p>long</p>`,
    "/short.js": `HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 40\r\n\r\n${CODE}`,
    "/twice.js": `HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: ${CODE.length}\r\nContent-Length: ${CODE.length}\r\n\r\n${CODE}`,
    "/chunked.js": `HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: ${CODE.length}\r\nTransfer-Encoding: chunked\r\n\r\n${CODE.length.toString(16)}\r\n${CODE}\r\n0\r\n\r\n`,
    "/long.js": `HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: 4\r\n\r\n${CODE}`,
    "/fine.js": `HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nContent-Length: ${CODE.length}\r\n\r\n${CODE}`,
};

export interface Framing {
    origin: string;
    close(): Promise<void>;
}

// An origin answering each path with the raw response `RESPONSES` names, then closing the connection.
export async function serveFraming(): Promise<Framing> {
    const server: Server = createServer((socket: Socket) => {
        socket.once("data", (data) => {
            const path = String(data).split(" ", 2)[1] ?? "/";
            socket.end(RESPONSES[path.split("?", 1)[0] ?? "/"] ?? "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
