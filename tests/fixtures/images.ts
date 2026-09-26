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

// Fonts, a stylesheet and scripts, one image under two URLs, and an SVG padded with comments.
const ASSETS = `<!DOCTYPE html><html lang="en"><head><title>Assets</title>
<link rel="stylesheet" href="/fonts.css">
<link rel="preload" href="/heavy.ttf" as="font" crossorigin>
<link rel="preload" href="/swift.woff2" as="font" crossorigin>
<script src="/bloated.js"></script><script src="/tight.js"></script>
</head><body><h1>Assets</h1>
<img src="/twin-a.jpg" width="80" height="60" alt="a"><img src="/twin-b.jpg" width="80" height="60" alt="b">
<img src="/bloated.svg" width="10" height="10" alt="bloated">
</body></html>`;

// A PNG the server answers as WebP to a client that accepts it.
const NEGOTIATED = `<!DOCTYPE html><html lang="en"><head><title>Negotiated</title></head><body><h1>Negotiated</h1>
<img src="/negotiated.png" width="320" height="240" alt="negotiated"></body></html>`;

// A lazy hero four times its box in the first viewport, and an eager image below the fold.
const LIVE = `<!DOCTYPE html><html lang="en"><head><title>Live</title></head><body style="margin:0"><h1>Live</h1>
<img src="/wide.jpg" width="100" height="75" loading="lazy" alt="hero">
<div style="height:2000px"></div>
<img src="/small.webp" width="64" height="64" alt="eager">
</body></html>`;

// The same page done right: an eager hero at its size, the image below the fold lazy.
const LIVE_CLEAN = `<!DOCTYPE html><html lang="en"><head><title>Live clean</title></head><body style="margin:0"><h1>Live clean</h1>
<img src="/wide.jpg" width="400" height="300" alt="hero">
<div style="height:2000px"></div>
<img src="/small.webp?lazy" width="64" height="64" loading="lazy" alt="lazy">
</body></html>`;

const PAGES: Record<string, string> = { "/": PAGE, "/assets": ASSETS, "/negotiated": NEGOTIATED, "/live": LIVE, "/live-clean": LIVE_CLEAN };

const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';

const FONTS_CSS = `@font-face { font-family: "Heavy"; src: url(/heavy.ttf) format("truetype"); }
@font-face { font-family: Swift; src: url(/swift.woff2) format("woff2"); font-display: swap; }
body { font-family: Swift, Heavy, sans-serif; }`;

// A script whose comments and indentation minification strips.
const BLOATED_JS = Array.from({ length: 300 }, (_, index) => `/* step ${index}: a comment that explains nothing at all */\nfunction    stepNumber${index}  ( argumentValue )   {\n        return    argumentValue   +   ${index} ;\n}\n`).join("");

// An SVG carrying a long comment SVGO drops.
const BLOATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><!-- ${"padding ".repeat(2000)}--><rect width="10" height="10"/></svg>`;

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
    const twin = await sharp({ create: { ...flat.create, width: 80, height: 60, background: "#a36" } }).jpeg().toBuffer();
    return {
        "/heavy.png": ["image/png", await sharp(grain(640, 480), raw).png({ compressionLevel: 0 }).toBuffer()],
        "/small.webp": ["image/webp", await sharp(flat).webp().toBuffer()],
        "/wide.jpg": ["image/jpeg", await sharp({ create: { ...flat.create, width: 400, height: 300 } }).jpeg({ quality: 70 }).toBuffer()],
        "/logo.svg": ["image/svg+xml", Buffer.from(LOGO)],
        "/twin-a.jpg": ["image/jpeg", twin],
        "/twin-b.jpg": ["image/jpeg", twin],
        "/bloated.svg": ["image/svg+xml", Buffer.from(BLOATED_SVG)],
        "/negotiated.png": ["image/png", await sharp(grain(320, 240), { raw: { width: 320, height: 240, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()],
        "/fonts.css": ["text/css", Buffer.from(FONTS_CSS)],
        "/bloated.js": ["text/javascript", Buffer.from(BLOATED_JS)],
        "/tight.js": ["text/javascript", Buffer.from("function a(b){return b+1}\n")],
        "/heavy.ttf": ["font/ttf", Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60)])],
        "/swift.woff2": ["font/woff2", Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(60)])],
    };
}

// Serves the gallery pages and their assets, cacheable for an hour, recording every path asked for; `/negotiated.png` is WebP to a client accepting it.
export async function serveGallery(): Promise<Gallery> {
    const files = await images();
    const negotiated = await sharp(files["/negotiated.png"]?.[1]).webp().toBuffer();
    const requested: string[] = [];
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://gallery").pathname;
        requested.push(pathname);
        const file = files[pathname];
        const page = PAGES[pathname];
        if (page) response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        else if (pathname === "/negotiated.png" && request.headers.accept?.includes("image/webp")) response.writeHead(200, { "content-type": "image/webp", vary: "accept", "cache-control": "max-age=3600" }).end(negotiated);
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
