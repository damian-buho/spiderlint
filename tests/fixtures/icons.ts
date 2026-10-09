// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import type { Origin } from "./origin.ts";

// A square opaque PNG of `size` pixels.
export function png(size: number): Promise<Buffer> {
    return sharp({ create: { width: size, height: size, channels: 3, background: "#336699" } })
        .png()
        .toBuffer();
}

// An ICO whose entries are the PNGs of `sizes`.
export async function ico(sizes: number[]): Promise<Buffer> {
    const images = await Promise.all(sizes.map((size) => png(size)));
    const header = Buffer.alloc(6 + 16 * sizes.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.byteLength;
    for (const [index, image] of images.entries()) {
        const entry = 6 + index * 16;
        header.writeUInt8((sizes[index] as number) % 256, entry);
        header.writeUInt8((sizes[index] as number) % 256, entry + 1);
        header.writeUInt16LE(1, entry + 4);
        header.writeUInt16LE(32, entry + 6);
        header.writeUInt32LE(image.byteLength, entry + 8);
        header.writeUInt32LE(offset, entry + 12);
        offset += image.byteLength;
    }
    return Buffer.concat([header, ...images]);
}

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16"/></svg>';
const BROWSERCONFIG = (tile: string) => `<?xml version="1.0" encoding="utf-8"?><browserconfig><msapplication><tile><square150x150logo src="${tile}"/></tile></msapplication></browserconfig>`;
const page = (head: string) => `<!DOCTYPE html><html lang="en"><head><title>Icons</title>${head}</head><body><h1>Icons</h1><a href="/other">other</a></body></html>`;

// `good`: every icon present, well-formed and the size it declares; `bad`: a 16 px apple-touch-icon declared 180×180, no /apple-touch-icon.png for a page linking none, a browserconfig.xml naming a missing tile, a manifest 512 icon that is 256 px, an SVG icon linked without its type, a two-colour mask icon.
export async function serveIcons(kind: "good" | "bad"): Promise<Origin> {
    const requested: string[] = [];
    const isGood = kind === "good";
    const head = isGood
        ? `<link rel="icon" href="/favicon.ico" sizes="16x16 32x32"><link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="mask-icon" href="/mask.svg" color="#336699"><link rel="manifest" href="/site.webmanifest"><meta name="msapplication-TileImage" content="/tile.png"><meta name="msapplication-config" content="/browserconfig.xml">`
        : `<link rel="icon" href="/favicon.ico"><link rel="icon" href="/icon.svg"><link rel="apple-touch-icon" href="/touch.png" sizes="180x180"><link rel="mask-icon" href="/mask.svg" color="#336699"><link rel="manifest" href="/site.webmanifest"><meta name="msapplication-config" content="/browserconfig.xml">`;
    const manifest = JSON.stringify({
        name: "Icons",
        start_url: "/",
        display: "standalone",
        icons: [
            { src: "/192.png", sizes: "192x192", type: "image/png" },
            { src: "/512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
    });
    const files: Record<string, [string, Buffer | string]> = {
        "/": ["text/html; charset=utf-8", page(head)],
        "/other": ["text/html; charset=utf-8", page(isGood ? head : "")],
        "/favicon.ico": ["image/x-icon", await ico([16, 32])],
        "/icon.svg": ["image/svg+xml", SVG],
        "/mask.svg": ["image/svg+xml", isGood ? SVG : SVG.replace("<rect", '<rect fill="#f00"/><rect style="fill: #00f"')],
        "/site.webmanifest": ["application/manifest+json", manifest],
        "/192.png": ["image/png", await png(192)],
        "/512.png": ["image/png", await png(isGood ? 512 : 256)],
        "/tile.png": ["image/png", await png(144)],
        "/browserconfig.xml": ["application/xml", BROWSERCONFIG(isGood ? "/tile.png" : "/missing-tile.png")],
        ...(isGood ? { "/apple-touch-icon.png": ["image/png", await png(180)] } : { "/touch.png": ["image/png", await png(16)] }),
    };
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://icons").pathname;
        requested.push(pathname);
        const file = files[pathname];
        response.writeHead(file ? 200 : 404, { "content-type": file?.[0] ?? "text/html; charset=utf-8" });
        response.end(file?.[1] ?? page(""));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requested, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
