// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

export interface Gallery {
    origin: string;
    requested: string[];
    close(): Promise<void>;
}

// One `<img>` per case: heavy PNG, WebP without dimensions, JPEG four times its width attribute, the same JPEG with srcset, SVG.
const PAGE = `<!DOCTYPE html><html lang="en"><head><title>Gallery</title></head><body><h1>Gallery</h1>
<img src="/heavy.png" width="640" height="480" alt="heavy">
<img src="/small.webp" alt="small">
<img src="/wide.jpg" width="100" height="75" alt="wide">
<img src="/wide.jpg" srcset="/wide.jpg 400w" width="100" height="75" alt="responsive">
<img src="/logo.svg" width="10" height="10" alt="logo">
</body></html>`;

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

// A horizontal gradient with seeded grain: the same bytes every run, stored poorly by an unfiltered PNG.
function grain(width: number, height: number): Buffer {
    const pixels = Buffer.alloc(width * height * 3);
    let seed = 1;
    for (let index = 0; index < pixels.length; index += 1) {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7F_FF_FF_FF;
        pixels[index] = (Math.floor(((index / 3) % width) * (200 / width)) + ((seed >> 16) % 48)) & 0xFF;
    }
    return pixels;
}

// Each image path with its content type and bytes.
async function images(): Promise<Record<string, [string, Buffer]>> {
    const raw = { raw: { width: 640, height: 480, channels: 3 as const } };
    const flat = { create: { width: 64, height: 64, channels: 3 as const, background: "#3a6" } };
    return {
        "/heavy.png": ["image/png", await sharp(grain(640, 480), raw).png({ compressionLevel: 0 }).toBuffer()],
        "/small.webp": ["image/webp", await sharp(flat).webp().toBuffer()],
        "/wide.jpg": ["image/jpeg", await sharp({ create: { ...flat.create, width: 400, height: 300 } }).jpeg({ quality: 70 }).toBuffer()],
        "/logo.svg": ["image/svg+xml", Buffer.from(LOGO)],
    };
}

// Serves the gallery page at `/` and its images, cacheable for an hour, recording every path asked for.
export async function serveGallery(): Promise<Gallery> {
    const files = await images();
    const requested: string[] = [];
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://gallery").pathname;
        requested.push(pathname);
        const file = files[pathname];
        if (pathname === "/") response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
        else if (file) response.writeHead(200, { "content-type": file[0], "cache-control": "max-age=3600" }).end(file[1]);
        else response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        requested,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
