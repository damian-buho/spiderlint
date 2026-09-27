// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { transform } from "esbuild";
import sharp, { type Metadata, type Sharp } from "sharp";
import { optimize } from "svgo";
import type { Facts, HtmlFacts, ResourceFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { resourceRule } from "../rules/builtin.ts";
import type { Finding, Make } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "images";
const TEXT = "text";
const FONTS = "fonts";
const LAYOUT = "imageLayout";
const TIMEOUT_SECONDS = 30;
const MAX_PIXELS = 50_000_000;
// Digests whose facts stay in memory, oldest dropped first.
const MEASURED_MAX = 1024;

// Thresholds under `org.spiderlint.images`.
export interface ImagesSettings {
    // A saving counts when it is at least this share of the asset and this many bytes.
    saving: { share: number; bytes: number };
    // Bytes above which an image is heavy.
    weight: number;
    // How many times its displayed width an image may ship.
    oversize: number;
}

const SETTINGS = {
    type: "object",
    additionalProperties: false,
    properties: {
        saving: { type: "object", additionalProperties: false, default: {}, properties: { share: { type: "number", minimum: 0, maximum: 1, default: 0.2 }, bytes: { type: "integer", minimum: 0, default: 10_000 } } },
        weight: { type: "integer", minimum: 0, default: 200_000 },
        oversize: { type: "number", minimum: 1, default: 2 },
    },
};

type Target = "same" | "webp" | "avif";

export interface ImageFacts {
    format: string;
    bytes: number;
    width?: number;
    height?: number;
    animated?: true;
    // Bytes after re-encoding, per target; SVGO’s output is an SVG’s `same`.
    encoded?: Partial<Record<Target, number>>;
}

// A stylesheet’s or script’s size before and after minification, and a stylesheet’s `@font-face` rules.
export interface TextFacts {
    bytes: number;
    minified: number;
    "font-faces"?: { family: string; display?: string }[];
}

// The rendered `<img>` boxes of a page, in CSS pixels from the top of the document.
export interface LayoutFacts {
    viewport: { width: number; height: number; dpr: number };
    images: { src: string; top: number; width: number; height: number; natural: number; loading: string }[];
}

// Encoders per output format, at the quality a CDN image service defaults to; png is palette-quantised as TinyPNG does.
const ENCODERS: Record<string, (image: Sharp) => Sharp> = {
    jpeg: (image) => image.jpeg({ quality: 80, mozjpeg: true }),
    png: (image) => image.png({ compressionLevel: 9, palette: true, effort: 7 }),
    webp: (image) => image.webp({ quality: 80, effort: 4 }),
    avif: (image) => image.avif({ quality: 50, effort: 4 }),
};
const LEGACY = new Set(["jpeg", "png", "gif"]);
const SCRIPTS = ["text/javascript", "application/javascript", "application/x-javascript", "application/ecmascript", "text/ecmascript"];
// Font formats by their first four bytes.
const FONT_TAGS: Record<string, string> = { wOF2: "woff2", wOFF: "woff", OTTO: "otf", "\0\u{1}\0\0": "ttf", true: "ttf", ttcf: "ttc" };
// `font-display` values that hide text while the font loads.
const INVISIBLE = new Set(["auto", "block"]);

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

// An SVG’s size, and its size after SVGO when SVGO can parse it.
function measureSvg(url: string, body: Uint8Array): ImageFacts {
    const text = Buffer.from(body).toString("utf8");
    try {
        return { format: "svg", bytes: body.byteLength, encoded: { same: Buffer.byteLength(optimize(text).data) } };
    } catch (error) {
        log.debug({ url, error: error instanceof Error ? error.message : String(error) }, "SVGO cannot parse the SVG");
        return { format: "svg", bytes: body.byteLength };
    }
}

// Format, size and the bytes each re-encoding would take, on one libvips thread; SVG goes through SVGO, never rasterised.
async function measure(url: string, contentType: string, body: Uint8Array): Promise<ImageFacts> {
    if (contentType === "image/svg+xml") return measureSvg(url, body);
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

// Facts per content type and body digest, so one image served under several URLs is measured once.
const measured = new Map<string, Promise<ImageFacts>>();

// An image’s facts, measured once per digest; a failed measurement is not remembered.
async function extract(url: string, contentType: string, body: Uint8Array): Promise<ImageFacts> {
    const digest = createHash("sha256").update(contentType).update("\0").update(body).digest("hex");
    const known = measured.get(digest);
    log.debug({ url, digest, isKnown: known !== undefined }, "image looked up by digest");
    if (known) return structuredClone(await known);
    const facts = measure(url, contentType, body);
    measured.set(digest, facts);
    if (measured.size > MEASURED_MAX) measured.delete(measured.keys().next().value as string);
    try {
        return structuredClone(await facts);
    } catch (error) {
        measured.delete(digest);
        throw error;
    }
}

// Each `@font-face` family and its `font-display`, read from esbuild’s minified CSS.
function fontFaces(css: string): NonNullable<TextFacts["font-faces"]> {
    return css.matchAll(/@font-face\{([^}]*)\}/g).map(([, block = ""]) => {
        const family = /font-family:\s*("[^"]*"|'[^']*'|[^;]*)/.exec(block)?.[1]?.replaceAll(/^["']|["']$/g, "") ?? "";
        const display = /font-display:\s*([^;]*)/.exec(block)?.[1]?.trim();
        return { family, ...(display && { display }) };
    }).toArray();
}

// A stylesheet’s or script’s bytes before and after esbuild minifies it.
async function extractText(url: string, contentType: string, body: Uint8Array): Promise<TextFacts> {
    const loader = contentType === "text/css" ? "css" : "js";
    const { code } = await transform(Buffer.from(body).toString("utf8"), { loader, minify: true, logLevel: "silent" });
    const faces = loader === "css" ? fontFaces(code) : [];
    log.debug({ url, loader, bytes: body.byteLength, minified: Buffer.byteLength(code), fontFaces: faces.length }, "text asset minified");
    return { bytes: body.byteLength, minified: Buffer.byteLength(code), ...(faces.length > 0 && { "font-faces": faces }) };
}

// A font’s format by its leading bytes, whatever its content type claims; EOT carries `LP` at byte 34.
async function extractFont(url: string, _contentType: string, body: Uint8Array): Promise<{ format: string; bytes: number }> {
    const tag = Buffer.from(body.subarray(0, 4)).toString("latin1");
    const format = FONT_TAGS[tag] ?? (body[34] === 0x4C && body[35] === 0x50 ? "eot" : "unknown");
    log.debug({ url, tag, format }, "font sniffed");
    return { format, bytes: body.byteLength };
}

// Where each rendered `<img>` sits and how many pixels it ships, read in the crawler’s page.
const LAYOUT_SCRIPT = `(() => ({
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    images: [...document.images].map((img) => {
        const box = img.getBoundingClientRect();
        return { src: img.getAttribute("src") ?? img.currentSrc, top: Math.round(box.top + scrollY), width: Math.round(box.width), height: Math.round(box.height), natural: img.naturalWidth, loading: img.loading };
    }),
}))()`;

// Bytes in kilobytes, rounded.
function kB(bytes: number): string {
    return `${Math.round(bytes / 1000)} kB`;
}

// The share saved when `after` beats `before` by both `saving` bounds.
function saved(saving: ImagesSettings["saving"], before: number, after: number | undefined): number | undefined {
    return after === undefined || before - after < saving.bytes || (before - after) / before < saving.share ? undefined : Math.round((1 - after / before) * 100);
}

const imageOf = (resource: ResourceFacts) => resource[ID] as ImageFacts | undefined;
const textOf = (resource: ResourceFacts) => resource[TEXT] as TextFacts | undefined;
const fontOf = (resource: ResourceFacts) => resource[FONTS] as { format: string; bytes: number } | undefined;
const isImage = (_page: Facts, resource: ResourceFacts) => imageOf(resource) !== undefined;
const valueOf = (resource: ResourceFacts) => imageOf(resource);
const FACTS = [`resources.${ID}`];

// A JPEG, PNG or GIF that WebP or AVIF would shrink.
const modernFormat: Make = (severity, settings) => resourceRule("images/modern-format", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    const encoded = image.encoded ?? {};
    const target = (["avif", "webp"] as const).filter((name) => encoded[name] !== undefined).toSorted((a, b) => (encoded[a] as number) - (encoded[b] as number))[0];
    const share = target && LEGACY.has(image.format) ? saved((settings as ImagesSettings).saving, image.bytes, encoded[target]) : undefined;
    return share === undefined ? undefined : `${image.format} of ${kB(image.bytes)} is ${kB(encoded[target as Target] as number)} as ${target} (${share} % smaller); used by ${pages} pages`;
}, FACTS, valueOf, { docs: "https://web.dev/articles/choose-the-right-image-format" })(severity);

// An image its own format, or SVGO, re-encodes much smaller.
const recompress: Make = (severity, settings) => resourceRule("images/recompress", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    const share = saved((settings as ImagesSettings).saving, image.bytes, image.encoded?.same);
    return share === undefined ? undefined : `${image.format} of ${kB(image.bytes)} re-encodes to ${kB(image.encoded?.same as number)} (${share} % smaller); used by ${pages} pages`;
}, FACTS, valueOf, { docs: "https://web.dev/articles/use-imagemin-to-compress-images" })(severity);

// An image heavier than `weight`.
const weight: Make = (severity, settings) => resourceRule("images/weight", isImage, (resource, pages) => {
    const image = imageOf(resource) as ImageFacts;
    const limit = (settings as ImagesSettings).weight;
    return image.bytes > limit ? `${image.format} of ${kB(image.bytes)} is above ${kB(limit)}; used by ${pages} pages` : undefined;
}, FACTS, valueOf, { docs: "https://developer.mozilla.org/docs/Learn_web_development/Extensions/Performance/Multimedia" })(severity);

// A stylesheet or script minification shrinks by both `saving` bounds.
const minify: Make = (severity, settings) => resourceRule("images/minify", (_page, resource) => textOf(resource) !== undefined, (resource, pages) => {
    const text = textOf(resource) as TextFacts;
    const share = saved((settings as ImagesSettings).saving, text.bytes, text.minified);
    return share === undefined ? undefined : `${resource.kind} of ${kB(text.bytes)} minifies to ${kB(text.minified)} (${share} % smaller); used by ${pages} pages`;
}, [`resources.${TEXT}`], textOf, { docs: "https://web.dev/articles/reduce-network-payloads-using-text-compression" })(severity);

// A font served in any format but WOFF2.
const fontFormat = resourceRule("images/font-format", (_page, resource) => fontOf(resource) !== undefined, (resource, pages) => {
    const font = fontOf(resource) as { format: string; bytes: number };
    return font.format === "woff2" ? undefined : `${font.format} font of ${kB(font.bytes)} is not WOFF2; used by ${pages} pages`;
}, [`resources.${FONTS}`], fontOf, { docs: "https://web.dev/articles/reduce-webfont-size" });

// A stylesheet whose `@font-face` rules hide text while their font loads.
const fontDisplay = resourceRule("images/font-display", (_page, resource) => textOf(resource)?.["font-faces"] !== undefined, (resource, pages) => {
    const invisible = (textOf(resource)?.["font-faces"] ?? []).filter((face) => INVISIBLE.has(face.display ?? "auto")).map((face) => face.family);
    return invisible.length === 0 ? undefined : `${invisible.length} @font-face without font-display: swap, fallback or optional (${[...new Set(invisible)].join(", ")}); used by ${pages} pages`;
}, [`resources.${TEXT}`], (resource) => textOf(resource)?.["font-faces"], { docs: "https://developer.mozilla.org/docs/Web/CSS/@font-face/font-display" });

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

type Box = LayoutFacts["images"][number];

// A page rule over its rendered `<img>` boxes, skipped on a page the layout extractor did not sample; hidden images are never judged.
function layoutRule(id: string, documentation: string, message: (count: number) => string, offends: (layout: LayoutFacts, box: Box, settings: ImagesSettings) => string | undefined): Make {
    return (severity, settings) => ({
        meta: { id, severity, scope: "page", facts: [LAYOUT], docs: documentation },
        check(page: Facts) {
            const layout = page[LAYOUT] as LayoutFacts | undefined;
            if (!layout) return;
            const locations = layout.images.filter((box) => box.width > 0 && box.height > 0).flatMap((box) => offends(layout, box, settings as ImagesSettings) ?? []);
            log.debug({ rule: id, url: page.url.href, images: layout.images.length, offending: locations.length }, "rendered images judged");
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

// `count` with the verb form agreeing with it.
const agree = (count: number, one: string, many: string) => (count === 1 ? one : many);

const dimensions = imgRule("images/dimensions", ["html.images"], "https://web.dev/articles/optimize-cls#images-without-dimensions", (count) => `${count} <img> without width and height, so the layout shifts as ${agree(count, "it loads", "they load")}`, (_page, img) => (img.width === undefined || img.height === undefined ? img.src : undefined));

const oversized: Make = (severity, settings) => {
    const { oversize } = settings as ImagesSettings;
    return imgRule("images/oversized", ["html.images", `resources.${ID}`], "https://web.dev/articles/serve-responsive-images", (count) => `${count} <img> without srcset ${agree(count, "ships", "ship")} over ${oversize}× the width ${agree(count, "it displays", "they display")}`, (page, img) => {
        const declared = Number(img.width);
        const intrinsic = img.srcset === undefined && /^\d+$/.test(img.width ?? "") ? loaded(page, img.src)?.width : undefined;
        return intrinsic !== undefined && declared > 0 && intrinsic > declared * oversize ? `${img.src} ${intrinsic} px for width=${declared}` : undefined;
    })(severity);
};

const lazyBelow = layoutRule("images/lazy-below-fold", "https://web.dev/articles/browser-level-image-lazy-loading", (count) => `${count} <img> below the fold without loading=lazy ${agree(count, "loads", "load")} before the reader scrolls`, (layout, box) => (box.top >= layout.viewport.height && box.loading !== "lazy" ? `${box.src} at ${box.top} px` : undefined));

const lazyAbove = layoutRule("images/lazy-above-fold", "https://web.dev/articles/lcp-lazy-loading", (count) => `${count} <img> in the first viewport with loading=lazy ${agree(count, "waits", "wait")} for layout before loading`, (layout, box) => (box.top < layout.viewport.height && box.loading === "lazy" ? `${box.src} at ${box.top} px` : undefined));

const renderedOversize = layoutRule("images/rendered-oversize", "https://web.dev/articles/serve-responsive-images", (count) => `${count} <img> ${agree(count, "ships", "ship")} far more pixels than the page renders`, (layout, box, settings) => (box.natural > box.width * layout.viewport.dpr * settings.oversize ? `${box.src} ${box.natural} px shown at ${box.width} px` : undefined));

export default definePlugin({
    name: "images",
    settings: SETTINGS,
    extractors: [{ id: LAYOUT, mode: "browser", cost: "expensive", cached: false, extract: async (_page, _body, live) => live && ((await live.evaluate(LAYOUT_SCRIPT)) as LayoutFacts) }],
    resources: [
        { id: ID, types: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "image/svg+xml"], extract },
        { id: TEXT, types: ["text/css", ...SCRIPTS], extract: extractText },
        { id: FONTS, types: ["font/", "application/font-", "application/x-font-", "application/vnd.ms-fontobject"], extract: extractFont },
    ],
    rules: { "images/modern-format": modernFormat, "images/recompress": recompress, "images/weight": weight, "images/dimensions": dimensions, "images/oversized": oversized, "images/minify": minify, "images/font-format": fontFormat, "images/font-display": fontDisplay, "images/lazy-below-fold": lazyBelow, "images/lazy-above-fold": lazyAbove, "images/rendered-oversize": renderedOversize },
    presets: {
        images: {
            description: "Image weight and markup: bytes a modern format or a re-encode saves, heavy and oversized images, layout shift",
            rules: { "images/modern-format": "warning", "images/recompress": "warning", "images/weight": "warning", "images/dimensions": "warning", "images/oversized": "warning" },
        },
        "images:assets": {
            description: "Fonts and text assets: WOFF2, font-display, and bytes minification saves",
            rules: { "images/font-format": "warning", "images/font-display": "warning", "images/minify": "warning" },
        },
        "images:live": {
            description: "Images as the browser lays them out, on sampled pages: lazy loading against the fold, pixels shipped against pixels shown",
            rules: { "images/lazy-below-fold": "warning", "images/lazy-above-fold": "warning", "images/rendered-oversize": "warning" },
        },
    },
});
