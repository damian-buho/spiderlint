// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { once } from "node:events";
import { Agent } from "node:http";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { Server } from "proxy-chain";

export interface Proxy {
    url: string;
    // Hosts each tunnel or forwarded request named, in arrival order.
    seen: string[];
    close(): Promise<void>;
}

// An HTTP proxy on loopback that records each host it forwards to, on its own agent rather than the proxied global one.
export async function serveHttpProxy(): Promise<Proxy> {
    const seen: string[] = [];
    const httpAgent = new Agent();
    const prepareRequestFunction = ({ hostname }: { hostname: string }) => {
        seen.push(hostname);
        return { httpAgent };
    };
    const server = new Server({ host: "127.0.0.1", port: 0, prepareRequestFunction });
    await server.listen();
    return { url: `http://127.0.0.1:${server.port}`, seen, close: () => server.close(true) };
}

// Reads exactly `size` bytes from `socket`.
async function read(socket: Socket, size: number): Promise<Buffer> {
    let buffered = Buffer.alloc(0);
    while (buffered.length < size) {
        const chunk = (socket.read(size - buffered.length) as Buffer | null) ?? (await once(socket, "readable"), Buffer.alloc(0));
        buffered = Buffer.concat([buffered, chunk]);
    }
    return buffered;
}

// One no-auth SOCKS5 CONNECT, domain or IPv4 target, then a blind pipe.
async function handshake(client: Socket, seen: string[]): Promise<void> {
    const [, methods = 0] = await read(client, 2);
    await read(client, methods);
    client.write(Buffer.from([5, 0]));
    const request = await read(client, 4);
    const length = request[3] === 3 ? await read(client, 1) : undefined;
    const name = await read(client, length ? (length[0] ?? 0) : 4);
    const host = length ? name.toString() : [...name].join(".");
    const port = await read(client, 2);
    seen.push(host);
    const upstream = connect(port.readUInt16BE(), host, () => {
        client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(client).pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
}

// A SOCKS5 proxy on loopback that records each host it connects to.
export async function serveSocksProxy(): Promise<Proxy> {
    const seen: string[] = [];
    const server = createServer((client) => void handshake(client, seen).catch(() => client.destroy()));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    return { url: `socks5h://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
