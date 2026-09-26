// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import sharp, { type Metadata, type Sharp } from "sharp";
import type { Facts, HtmlFacts, ResourceFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resourceRule } from "../rules/builtin.ts";
import type { Finding, Make } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "images";
const TIMEOUT_SECONDS = 30;
const MAX_PIXELS = 50_000_000;
// A saving counts when it is at least this share of the image and this many bytes.
const SAVING = { share: 0.2, bytes: 10_000 };
const WEIGHT = 200_000;
// An `<img>` is oversized when its intrinsic width exceeds its `width` attribute this many times.
const OVERSIZE = 2;

type Target = "same" | "webp" | "avif";

export interface ImageFacts {
    format: string;
    bytes: number;
    width?: number;
    height?: number;
    animated?: true;
    // Bytes after re-encoding, per target.
    encoded?: Partial<Record<Target, number>>;
}

// Encoders per output format, at the quality a CDN image service defaults to; png is palette-quantised as TinyPNG does.
const ENCODERS: Record<string, (image: Sharp) => Sharp> = {
    jpeg: (image) => image.jpeg({ quality: 80, mozjpeg: true }),
    png: (image) => image.png({ compressionLevel: 9, palette: true, effort: 7 }),
    webp: (image) => image.webp({ quality: 80, effort: 4 }),
    avif: (image) => image.avif({ quality: 50, effort: 4 }),
};
const LEGACY = new Set(["jpeg", "png", "gif"]);

// sharp reports AVIF as `heif` with AV1 compression.
function formatOf(metadata: Metadata): string {
    return metadata.format === "heif" && metadata.compression === "av1" ? "avif" : metadata.format;
}

// Re-encode targets for `format`: its own encoder, then WebP and AVIF; libvips encodes no animated AVIF.
function targetsOf(format: string, isAnimated: boolean): [Target, string][] {
    const own: [Target, string][] = Object.hasOwn(ENCODERS, format) && !(isAnimated && format === "avif") ? [["same", format]] : [];
    const modern: [Target, string][] = LEGACY.has(format) ? [["webp", "webp"], ...(isAnimated ? [] : [["avif", "avif"] as [Target, string]])] : [];
    return [...own, ...modern];
}

// Format, size and the bytes each re-encoding would take, on one libvips thread; SVG is measured, never rasterised.
async function extract(url: string, contentType: string, body: Uint8Array): Promise<ImageFacts> {
    if (contentType === "image/svg+xml") return { format: "svg", bytes: body.byteLength };
    sharp.concurrency(1);
    sharp.cache(false);
    const input = () => sharp(body, { animated: true, limitInputPixels: MAX_PIXELS }).timeout({ seconds: TIMEOUT_SECONDS });
    const metadata = await input().metadata();
    const format = formatOf(metadata);
    const isAnimated = (metadata.pages ?? 1) > 1;
    const facts: ImageFacts = { format, bytes: body.byteLength, width: metadata.width, height: isAnimated ? metadata.pageHeight : metadata.height, ...(isAnimated && { animated: true as const }) };
    const encoded: ImageFacts["encoded"] = {};
    for (const [target, output] of targetsOf(format, isAnimated)) {
        const buffer = await (ENCODERS[output] as (image: Sharp) => Sharp)(input()).toBuffer();
        encoded[target] = buffer.byteLength;
    }
    log.debug({ url, format, bytes: body.byteLength, isAnimated, encoded }, "image measured");
    return Object.keys(encoded).length > 0 ? { ...facts, encoded } : facts;
}

// Bytes in kilobytes, rounded.
function kB(bytes: number): string {
    return `${Math.round(bytes / 1000)} kB`;
}

// The share saved when `after` beats `before` by both SAVING bounds.
function saved(before: number, after: number | undefined): number | undefined {
    return after === undefined || before - after < SAVING.bytes || (before - after) / before < SAVING.share ? undefined : Math.round((1 - after / before) * 100);
}

const imageOf = (resource: ResourceFacts) => resource[ID] as ImageFacts | undefined;
const isImage = (_page: Facts, resource: ResourceFacts) => imageOf(resource) !== undefined;
const valueOf = (resource: ResourceFacts) => imageOf(resource);
const FACTS = [`resources.${ID}`];

// A JPEG, PNG or GIF that WebP or AVIF would shrink.
const modernFormat = resourceRule("images/modern-format", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    const encoded = image.encoded ?? {};
    const target = (["avif", "webp"] as const).filter((name) => encoded[name] !== undefined).toSorted((a, b) => (encoded[a] as number) - (encoded[b] as number))[0];
    const share = target && LEGACY.has(image.format) ? saved(image.bytes, encoded[target]) : undefined;
    return share === undefined ? undefined : `${image.format} of ${kB(image.bytes)} is ${kB(encoded[target as Target] as number)} as ${target} (${share} % smaller); used by ${pages} pages`;
}, FACTS, valueOf, { docs: "https://web.dev/articles/choose-the-right-image-format" });

// An image its own format re-encodes much smaller.
const recompress = resourceRule("images/recompress", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    const share = saved(image.bytes, image.encoded?.same);
    return share === undefined ? undefined : `${image.format} of ${kB(image.bytes)} re-encodes to ${kB(image.encoded?.same as number)} (${share} % smaller); used by ${pages} pages`;
}, FACTS, valueOf, { docs: "https://web.dev/articles/use-imagemin-to-compress-images" });

// An image heavier than WEIGHT.
const weight = resourceRule("images/weight", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    return image.bytes > WEIGHT ? `${image.format} of ${kB(image.bytes)} is above ${kB(WEIGHT)}; used by ${pages} pages` : undefined;
}, FACTS, valueOf, { docs: "https://developer.mozilla.org/docs/Learn_web_development/Extensions/Performance/Multimedia" });

type Img = HtmlFacts["images"][number];

// A page rule over its `<img>` elements: one finding listing each offender as a location.
function imgRule(id: string, facts: string[], documentation: string, message: (count: number) => string, offends: (page: Facts, img: Img) => string | undefined): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts, docs: documentation },
        check(page: Facts) {
            if (!page.html) return;
            const locations = page.html.images.filter((img) => !img.noscript).flatMap((img) => offends(page, img) ?? []);
            log.debug({ rule: id, url: page.url.href, images: page.html.images.length, offending: locations.length }, "images judged");
            return locations.length === 0 ? [] : [{ rule: id, severity, scope: "page", url: page.url.href, group: page.group, message: message(locations.length), value: locations, locations } satisfies Finding];
        },
    });
}

// The image facts of the resource an `<img src>` loads.
function loaded(page: Facts, source: string): ImageFacts | undefined {
    if (!URL.canParse(source, page.url.href)) return undefined;
    const url = new URL(source, page.url.href);
    url.hash = "";
    const resource = page.resources?.find((entry) => entry.url === url.href && imageOf(entry));
    return resource && imageOf(resource);
}

const dimensions = imgRule("images/dimensions", ["html.images"], "https://web.dev/articles/optimize-cls#images-without-dimensions", (count) => `${count} <img> without width and height, so the layout shifts as ${count === 1 ? "it loads" : "they load"}`, (_page, img) => (img.width === undefined || img.height === undefined ? img.src : undefined));

const oversized = imgRule("images/oversized", ["html.images", `resources.${ID}`], "https://web.dev/articles/serve-responsive-images", (count) => `${count} <img> without srcset ${count === 1 ? "ships" : "ship"} over ${OVERSIZE}× the width ${count === 1 ? "it displays" : "they display"}`, (page, img) => {
    const declared = Number(img.width);
    const intrinsic = img.srcset === undefined && /^\d+$/.test(img.width ?? "") ? loaded(page, img.src)?.width : undefined;
    return intrinsic !== undefined && declared > 0 && intrinsic > declared * OVERSIZE ? `${img.src} ${intrinsic} px for width=${declared}` : undefined;
});

export default definePlugin({
    name: "images",
    resources: [{ id: ID, types: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml"], extract }],
    rules: { "images/modern-format": modernFormat, "images/recompress": recompress, "images/weight": weight, "images/dimensions": dimensions, "images/oversized": oversized },
    presets: {
        images: {
            description: "Image weight and markup: bytes a modern format or a re-encode saves, heavy and oversized images, layout shift",
            rules: { "images/modern-format": "warning", "images/recompress": "warning", "images/weight": "warning", "images/dimensions": "warning", "images/oversized": "warning" },
        },
    },
});
