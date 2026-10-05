// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { load } from "cheerio";
import sharp from "sharp";
import { optimize } from "svgo";
import { reason } from "../crawl/fetch.ts";
import { RobotsDisallowed, type Probe } from "../crawl/probe.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Severity } from "../rules/types.ts";
import { mediaType } from "./origin.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

const ID = "icons";
const APPLE = "180x180";
const ICO_SIZES = ["16x16", "32x32"];
const SVG = "image/svg+xml";
const MAX_PIXELS = 50_000_000;
// A fill or stroke paint, as an attribute or a style declaration.
const PAINT = /\b(?:fill|stroke)\s*[:=]\s*["']?\s*([^"';\s>]+)/gi;
// Paints that add no colour of their own.
const UNPAINTED = new Set(["none", "transparent", "currentcolor", "inherit"]);

type Source = "icon" | "apple-touch-icon" | "mask-icon" | "manifest" | "ms-tile";

// One icon a page, the manifest or browserconfig.xml names.
export interface DeclaredIcon {
    url: string;
    source: Source;
    sizes?: string;
    type?: string;
    color?: string;
}

// What an icon URL answered: its served type, sniffed format, pixel sizes and, for a PNG, whether it is opaque.
export interface IconFile {
    status: number;
    type?: string;
    format?: string;
    sizes?: string[];
    opaque?: boolean;
    xml?: false;
    // Distinct fill and stroke paints an SVG names; none named paints black.
    colours?: number;
    error?: string;
}

export interface IconsFacts {
    declared: DeclaredIcon[];
    files: Record<string, IconFile>;
    favicon: string[];
    svg: string[];
    "apple-touch": string[];
    "mask-icon": string[];
    "ms-tile": string[];
    "declared-size": string[];
}

// Media types an icon may declare, by the format they name.
const TYPES: Record<string, string> = { "image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico", [SVG]: "svg", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };

// The lower-cased tokens of a `rel`, `sizes` or `purpose` value.
const tokens = (value: string | undefined) => (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);

// The sizes an ICO directory lists, 0 standing for 256.
function icoSizes(bytes: Buffer): string[] {
    const count = bytes.byteLength >= 6 ? bytes.readUInt16LE(4) : 0;
    const sizes: string[] = [];
    for (let entry = 0; entry < count && 6 + (entry + 1) * 16 <= bytes.byteLength; entry += 1) {
        const offset = 6 + entry * 16;
        sizes.push(`${bytes[offset] || 256}x${bytes[offset + 1] || 256}`);
    }
    return sizes;
}

// The format, pixel sizes and opacity of an icon body; an unrecognised body has no format.
async function measure(url: string, bytes: Buffer): Promise<Pick<IconFile, "format" | "sizes" | "opaque" | "xml">> {
    if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return { format: "ico", sizes: icoSizes(bytes) };
    const text = bytes.subarray(0, 1024).toString("utf8");
    if (/<svg[\s>]/i.test(text)) {
        const svg = bytes.toString("utf8");
        const colours = new Set(
            svg
                .matchAll(PAINT)
                .map((match) => String(match[1]).toLowerCase())
                .filter((paint) => !UNPAINTED.has(paint)),
        ).size;
        try {
            optimize(svg);
            return { format: "svg", ...(colours > 0 && { colours }) };
        } catch (error) {
            log.debug({ url, error: reason(error) }, "SVG icon does not parse");
            return { format: "svg", xml: false };
        }
    }
    try {
        const image = sharp(bytes, { limitInputPixels: MAX_PIXELS });
        const metadata = await image.metadata();
        const stats = metadata.format === "png" ? await image.stats() : undefined;
        const opaque = stats?.isOpaque;
        return { format: metadata.format, sizes: [`${metadata.width}x${metadata.height}`], ...(opaque !== undefined && { opaque }) };
    } catch (error) {
        log.debug({ url, error: reason(error) }, "icon is no image");
        return {};
    }
}

// Every icon URL fetched once per origin, on its own host through the delegated probe.
function fetcher(origin: string, context: SiteContext): (url: string) => Promise<IconFile> {
    const files = new Map<string, Promise<IconFile>>();
    const fetchOne = async (url: string): Promise<IconFile> => {
        try {
            const answer: Probe = await (new URL(url).origin === origin ? context.fetch : context.delegated)(url, { redirect: "follow", binary: true });
            const isOk = answer.status >= 200 && answer.status <= 299;
            const measured = isOk && answer.bytes ? await measure(url, answer.bytes) : {};
            log.debug({ url, status: answer.status, ...measured }, "icon fetched");
            return { status: answer.status, type: mediaType(answer), ...measured };
        } catch (error) {
            log.debug({ url, error: reason(error) }, "icon unreachable");
            return { status: 0, error: error instanceof RobotsDisallowed ? "robots.txt disallows it" : reason(error) };
        }
    };
    return (url) => {
        if (!files.has(url)) files.set(url, fetchOne(url));
        return files.get(url) as Promise<IconFile>;
    };
}

// The icons the origin’s pages link, one entry per source, URL, sizes and type.
function linkedIcons(pages: readonly Facts[]): DeclaredIcon[] {
    const found = new Map<string, DeclaredIcon>();
    for (const page of pages) {
        const links = page.html?.head.links ?? [];
        for (const link of links) {
            const relation = tokens(link.rel);
            const source: Source | undefined = relation.includes("mask-icon") ? "mask-icon" : relation.some((token) => token.startsWith("apple-touch-icon")) ? "apple-touch-icon" : relation.includes("icon") ? "icon" : undefined;
            if (!source || !link.href) continue;
            const icon: DeclaredIcon = { url: link.href, source, ...(link.sizes && { sizes: link.sizes }), ...(link.type && { type: link.type.toLowerCase() }), ...(link.color && { color: link.color }) };
            found.set(JSON.stringify(icon), icon);
        }
        const metas = page.html?.metas ?? [];
        for (const meta of metas) if (meta.name.toLowerCase() === "msapplication-tileimage" && URL.canParse(meta.content, page.url.href)) found.set(`tile ${meta.content}`, { url: new URL(meta.content, page.url.href).href, source: "ms-tile" });
    }
    return found.values().toArray();
}

// The icons each linked manifest lists; a manifest that does not answer or parse lists none, `manifest/parse` reports it.
async function manifestIcons(pages: readonly Facts[], origin: string, context: SiteContext): Promise<DeclaredIcon[]> {
    const urls = new Set(pages.flatMap((page) => (page.html?.head.links ?? []).filter((link) => tokens(link.rel).includes("manifest") && link.href).map((link) => link.href as string)));
    const icons: DeclaredIcon[] = [];
    for (const url of urls) {
        try {
            const answer = await (new URL(url).origin === origin ? context.fetch : context.delegated)(url, { redirect: "follow" });
            const listed = (JSON.parse(answer.body) as { icons?: unknown }).icons;
            const entries = Array.isArray(listed) ? (listed as { src?: unknown; sizes?: unknown; type?: unknown }[]) : [];
            for (const icon of entries) {
                if (typeof icon.src !== "string" || !URL.canParse(icon.src, answer.url)) continue;
                icons.push({ url: new URL(icon.src, answer.url).href, source: "manifest", ...(typeof icon.sizes === "string" && { sizes: icon.sizes }), ...(typeof icon.type === "string" && { type: icon.type.toLowerCase() }) });
            }
            log.debug({ url, icons: icons.length }, "manifest icons read");
        } catch (error) {
            log.debug({ url, error: reason(error) }, "manifest icons unreadable");
        }
    }
    return icons;
}

// browserconfig.xml’s tile images, and what is wrong with the file; one nobody names and that answers 404 is absent.
async function browserConfig(pages: readonly Facts[], origin: string, context: SiteContext): Promise<{ tiles: string[]; problems: string[] }> {
    const named = pages.flatMap((page) => (page.html?.metas ?? []).filter((meta) => meta.name.toLowerCase() === "msapplication-config" && meta.content.toLowerCase() !== "none" && URL.canParse(meta.content, page.url.href)).map((meta) => new URL(meta.content, page.url.href).href));
    const url = named[0] ?? `${origin}/browserconfig.xml`;
    let answer: Pick<Probe, "status" | "body" | "url">;
    try {
        answer = await (new URL(url).origin === origin ? context.fetch : context.delegated)(url, { redirect: "follow" });
    } catch (error) {
        log.debug({ url, error: reason(error) }, "browserconfig.xml unreachable");
        answer = { status: 0, body: "", url };
    }
    log.debug({ url, status: answer.status, isNamed: named.length > 0 }, "browserconfig.xml fetched");
    if (answer.status < 200 || answer.status > 299) return { tiles: [], problems: named.length > 0 ? [`${url} answers ${answer.status || "nothing"}`] : [] };
    const $ = load(answer.body, { xml: true });
    if ($("browserconfig msapplication").length === 0) return { tiles: [], problems: [`${url} does not parse as a browserconfig document`] };
    const tiles = $("browserconfig msapplication tile *[src]")
        .map((_, element) => String($(element).attr("src")))
        .get()
        .filter((named) => URL.canParse(named, answer.url))
        .map((named) => new URL(named, answer.url).href);
    return { tiles, problems: [] };
}

const isOk = (file: IconFile | undefined) => file !== undefined && file.status >= 200 && file.status <= 299;
// What is wrong with fetching `url`, when something is: no answer, not 2xx, or no image in the body.
function unusable(url: string, file: IconFile | undefined): string | undefined {
    if (!file || file.error) return `${url} does not answer${file?.error ? ` (${file.error})` : ""}`;
    if (!isOk(file)) return `${url} answers ${file.status}`;
    return file.format ? undefined : `${url} is not an image (${file.type || "no type"})`;
}

// Favicon: a linked icon or /favicon.ico, each a real image, an ICO carrying 16 and 32 px.
function faviconProblems(declared: DeclaredIcon[], files: Record<string, IconFile>, root: string): string[] {
    const linked = declared.filter((icon) => icon.source === "icon");
    const rootFile = files[root];
    if (linked.length === 0 && !isOk(rootFile)) return [`no <link rel=icon> and ${root} answers ${rootFile?.status || "nothing"}`];
    const judged = [...new Set([...linked.map((icon) => icon.url), ...(isOk(rootFile) ? [root] : [])])];
    return judged.flatMap((url) => {
        const file = files[url];
        const problem = unusable(url, file);
        if (problem) return [problem];
        const missing = file?.format === "ico" ? ICO_SIZES.filter((size) => !file.sizes?.includes(size)) : [];
        return missing.length > 0 ? [`${url} holds ${file?.sizes?.join(", ") || "no image"}, not ${ICO_SIZES.join(" and ")}`] : [];
    });
}

// SVG favicon: one linked with its media type, parsing as XML.
function svgProblems(declared: DeclaredIcon[], files: Record<string, IconFile>): string[] {
    const svgs = declared.filter((icon) => icon.source === "icon" && (icon.type === SVG || files[icon.url]?.format === "svg" || new URL(icon.url).pathname.endsWith(".svg")));
    if (svgs.length === 0) return ["no <link rel=icon> names an SVG, which scales and can follow dark mode"];
    return svgs.flatMap((icon) => {
        const file = files[icon.url];
        const problem = unusable(icon.url, file);
        if (problem) return [problem];
        if (file?.xml === false) return [`${icon.url} does not parse as XML`];
        return icon.type === SVG ? [] : [`${icon.url} is linked without type="${SVG}"`];
    });
}

// Apple touch icon: linked, or at /apple-touch-icon.png for pages linking none; an opaque PNG, one of them 180×180.
function appleProblems(declared: DeclaredIcon[], files: Record<string, IconFile>, root: string, unlinked: number): string[] {
    const linked = declared.filter((icon) => icon.source === "apple-touch-icon");
    const problems = unlinked > 0 && !isOk(files[root]) ? [`${unlinked} pages link no apple-touch-icon and ${root} answers ${files[root]?.status || "nothing"}`] : [];
    const judged = [...linked, ...(unlinked > 0 && isOk(files[root]) ? [{ url: root, source: "apple-touch-icon" as const }] : [])];
    for (const icon of judged) {
        const file = files[icon.url];
        const problem = unusable(icon.url, file);
        if (problem) problems.push(problem);
        else if (file?.format !== "png") problems.push(`${icon.url} is ${file?.format}, not PNG`);
        else if (file.opaque === false) problems.push(`${icon.url} has transparent pixels, which iOS draws black`);
    }
    const sizes = judged.map((icon) => ("sizes" in icon && icon.sizes ? tokens(icon.sizes)[0] : files[icon.url]?.sizes?.[0]));
    if (judged.length > 0 && !sizes.includes(APPLE)) problems.push(`no apple-touch-icon is ${APPLE} (got ${sizes.map((size) => size ?? "unknown").join(", ")})`);
    return problems;
}

// Safari pinned tab: a single-colour SVG with a `color`, judged only when linked.
function maskProblems(declared: DeclaredIcon[], files: Record<string, IconFile>): string[] {
    return declared
        .filter((icon) => icon.source === "mask-icon")
        .flatMap((icon) => {
            const problem = unusable(icon.url, files[icon.url]);
            if (problem) return [problem];
            const colours = files[icon.url]?.colours ?? 0;
            return [...(files[icon.url]?.format === "svg" ? [] : [`${icon.url} is not an SVG`]), ...(colours > 1 ? [`${icon.url} paints ${colours} colours, not one`] : []), ...(icon.color ? [] : [`${icon.url} is linked without a color`])];
        });
}

// Windows tiles: each `msapplication-TileImage` and browserconfig.xml tile answers with an image.
function tileProblems(declared: DeclaredIcon[], files: Record<string, IconFile>, config: { tiles: string[]; problems: string[] }): string[] {
    const urls = [...new Set([...declared.filter((icon) => icon.source === "ms-tile").map((icon) => icon.url), ...config.tiles])];
    return [...config.problems, ...urls.flatMap((url) => unusable(url, files[url]) ?? [])];
}

// Declared sizes and type against the measured file; an SVG is any size.
function sizeProblems(declared: DeclaredIcon[], files: Record<string, IconFile>): string[] {
    const problems = new Set<string>();
    for (const icon of declared) {
        const file = files[icon.url];
        if (!file?.format) continue;
        const claimed = tokens(icon.sizes).filter((size) => size !== "any");
        const wrong = file.format === "svg" ? [] : claimed.filter((size) => !file.sizes?.includes(size));
        if (wrong.length > 0) problems.add(`${icon.url} declares ${claimed.join(" ")} but is ${file.sizes?.join(" ") ?? "unmeasured"}`);
        const format = icon.type && TYPES[icon.type];
        if (icon.type && format !== file.format) problems.add(`${icon.url} declares ${icon.type} but is ${file.format}`);
    }
    return [...problems];
}

// Every icon the origin’s pages, manifest and browserconfig.xml name, fetched once, measured and judged.
const icons: SiteExtractor = {
    id: ID,
    per: "origin",
    crawled: true,
    version: "2",
    async extract(origin, context) {
        const pages = context.pages.filter((page) => page.html !== undefined);
        if (pages.length === 0) return;
        const get = fetcher(origin, context);
        const declared = [...linkedIcons(pages), ...(await manifestIcons(pages, origin, context))];
        const config = await browserConfig(pages, origin, context);
        const favicon = `${origin}/favicon.ico`;
        const apple = `${origin}/apple-touch-icon.png`;
        const unlinked = pages.filter((page) => (page.html?.head.links ?? []).every((link) => tokens(link.rel).every((token) => !token.startsWith("apple-touch-icon")))).length;
        const urls = [...new Set([...declared.map((icon) => icon.url), ...config.tiles, favicon, apple])];
        const files = Object.fromEntries(await Promise.all(urls.map(async (url) => [url, await get(url)] as const)));
        log.debug({ origin, declared: declared.length, files: urls.length, unlinked }, "icons measured");
        return {
            declared,
            files,
            favicon: faviconProblems(declared, files, favicon),
            svg: svgProblems(declared, files),
            "apple-touch": appleProblems(declared, files, apple, unlinked),
            "mask-icon": maskProblems(declared, files),
            "ms-tile": tileProblems(declared, files, config),
            "declared-size": sizeProblems(declared, files),
        } satisfies IconsFacts;
    },
};

// A rule over one of the per-origin problem lists.
function problemRule(check: keyof IconsFacts, severity: Severity, score: number, message: string, documentation: string, fix: string) {
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {got} is the rule message placeholder
    return { fact: `site.origins.*.${ID}.${check}`, expect: { maxItems: 0 }, message: `${message}: {got}`, severity, score, docs: documentation, fix };
}

export default definePlugin({
    name: ID,
    sites: [icons],
    presets: {
        icons: {
            description: "Favicons and platform icons fetched and measured: the favicon, SVG, Apple touch, Safari pinned tab and Windows tile icons, and every declared size",
            rules: {
                "icons/favicon": problemRule("favicon", "warning", 4.6, "the favicon is missing or broken", "https://developers.google.com/search/docs/appearance/favicon-in-search", "Link an icon with <link rel=icon>, or serve /favicon.ico as an ICO holding 16 and 32 px images."),
                "icons/svg": problemRule("svg", "hint", 0.6, "no usable SVG favicon", "https://developer.mozilla.org/docs/Web/HTML/Reference/Attributes/rel#icon", `Link a well-formed SVG with <link rel=icon type="${SVG}">.`),
                "icons/apple-touch": problemRule(
                    "apple-touch",
                    "warning",
                    3.8,
                    "the Apple touch icon is missing or unfit",
                    "https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html",
                    "Serve an opaque 180×180 PNG at /apple-touch-icon.png, or link one with <link rel=apple-touch-icon>.",
                ),
                "icons/mask-icon": problemRule(
                    "mask-icon",
                    "hint",
                    0.4,
                    "the Safari pinned tab icon is unusable; since Safari 12 an SVG rel=icon serves instead",
                    "https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/pinnedTabs/pinnedTabs.html",
                    "Link a single-colour SVG with a color attribute, or drop rel=mask-icon.",
                ),
                "icons/ms-tile": problemRule(
                    "ms-tile",
                    "info",
                    1.4,
                    "a Windows tile image or browserconfig.xml is broken",
                    "https://learn.microsoft.com/previous-versions/windows/internet-explorer/ie-developer/platform-apis/dn320426(v=vs.85)",
                    "Serve every image msapplication-TileImage and browserconfig.xml name, or remove them.",
                ),
                "icons/declared-size": problemRule("declared-size", "warning", 4.2, "icons are not the size or type they declare", "https://developer.mozilla.org/docs/Web/HTML/Reference/Attributes/sizes", "Make each icon’s sizes and type match the file, or correct the declaration."),
            },
        },
    },
});
