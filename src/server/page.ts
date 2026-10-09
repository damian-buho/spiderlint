// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { ConfigError } from "../config/index.ts";
import { LANGUAGES, translator } from "../i18n.ts";
import { log } from "../logger.ts";

export type Slot = "head" | "header" | "footer";

// What a rendered fragment adds to a page’s content security policy.
export interface Sources {
    script: string[];
    style: string[];
}

const SLOTS: Slot[] = ["head", "header", "footer"];
const FILE = /^(head|header|footer)(?:\.([a-z]{2,3}))?\.html$/;
const RELOAD_MS = 5000;
const MEDIA: Record<string, string> = {
    js: "text/javascript",
    mjs: "text/javascript",
    css: "text/css",
    json: "application/json",
    map: "application/json",
    txt: "text/plain; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff2: "font/woff2",
    woff: "font/woff",
};

// The CSP hash source of `text`.
function hashOf(text: string): string {
    return `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
}

// What a fragment’s scripts and styles ask of the policy: inline ones by hash, external ones by origin; an external one without `integrity` or off https is a ConfigError naming the file.
function sourcesOf(file: string, html: string): Sources {
    const found = { script: new Set<string>(), style: new Set<string>() };
    const $ = load(html, undefined, false);
    for (const element of $("script, style, link[rel~=stylesheet]")) {
        const name = element.tagName;
        const kind = name === "script" ? "script" : "style";
        const attribute = name === "script" ? "src" : "href";
        const reference = $(element).attr(attribute);
        if (name === "style" || (name === "script" && reference === undefined)) {
            found[kind].add(hashOf($(element).html() ?? ""));
            continue;
        }
        if (reference === undefined) continue;
        if (!$(element).attr("integrity")) throw new ConfigError(`page/${file}: <${name} ${attribute}="${reference}"> needs an integrity attribute`);
        const isLocal = reference.startsWith("/") && !reference.startsWith("//");
        if (!isLocal && !(URL.canParse(reference) && new URL(reference).protocol === "https:")) throw new ConfigError(`page/${file}: ${reference} must be an https URL or a path on this server`);
        found[kind].add(isLocal ? "'self'" : new URL(reference).origin);
    }
    return { script: [...found.script], style: [...found.style] };
}

// The page fragments of one directory — `head`, `header` and `footer`, each `<slot>.html` or `<slot>.<lang>.html` — rendered for every language when read, so a bad one fails at once.
export class Fragments {
    private rendered = new Map<string, { html: string; sources: Sources }>();
    private signature = "";
    private checked = 0;
    readonly directory: string;

    constructor(directory: string) {
        this.directory = directory;
        this.read();
    }

    // The files of the directory with their modification times.
    private scan(): string {
        return readdirSync(this.directory)
            .filter((file) => FILE.test(file))
            .toSorted((a, b) => a.localeCompare(b))
            .map((file) => `${file}:${statSync(path.join(this.directory, file)).mtimeMs}`)
            .join("\n");
    }

    // Reads every fragment and renders it for every language; throws ConfigError on a bad one.
    private read(): void {
        let files: string[];
        try {
            files = readdirSync(this.directory)
                .filter((file) => FILE.test(file))
                .toSorted((a, b) => a.localeCompare(b));
        } catch (error) {
            throw new ConfigError(`page/directory: ${this.directory} cannot be read (${error instanceof Error ? error.message : String(error)})`);
        }
        const texts = new Map(files.map((file) => [file, readFileSync(path.join(this.directory, file), "utf8")]));
        const rendered = new Map<string, { html: string; sources: Sources }>();
        for (const lang of LANGUAGES) {
            for (const slot of SLOTS) {
                const file = texts.has(`${slot}.${lang}.html`) ? `${slot}.${lang}.html` : `${slot}.html`;
                const text = texts.get(file);
                if (text === undefined) continue;
                const html = text.replaceAll("{lang}", () => lang).replaceAll("{dir}", () => translator(lang).dir);
                const sources = sourcesOf(file, html);
                rendered.set(`${slot}.${lang}`, { html, sources });
                log.debug({ file, lang, scripts: sources.script, styles: sources.style }, "page fragment rendered");
            }
        }
        this.rendered = rendered;
        this.signature = this.scan();
        log.info({ directory: this.directory, files, hashes: rendered.values().reduce((sum, entry) => sum + entry.sources.script.length + entry.sources.style.length, 0) }, "page fragments loaded");
    }

    // Rereads the files when one changed, at most every few seconds; a bad edit is logged and the last good fragments stay.
    private refresh(): void {
        const now = Date.now();
        if (now - this.checked < RELOAD_MS) return;
        this.checked = now;
        try {
            const current = this.scan();
            if (current === this.signature) return;
            try {
                this.read();
            } catch (error) {
                log.error({ directory: this.directory, error: error instanceof Error ? error.message : String(error) }, "page fragments rejected; previous kept");
                this.signature = current;
            }
        } catch (error) {
            log.error({ directory: this.directory, error: error instanceof Error ? error.message : String(error) }, "page fragments unreadable; previous kept");
        }
    }

    // The fragment for `slot` in `lang`, `{lang}` and `{dir}` filled, and what it adds to the policy.
    slot(slot: Slot, lang: string): { html: string; sources: Sources } {
        this.refresh();
        return this.rendered.get(`${slot}.${lang}`) ?? { html: "", sources: { script: [], style: [] } };
    }
}

// The directory a settings file names, or a ConfigError.
export function directoryOf(key: string, value: string): string {
    try {
        if (statSync(value).isDirectory()) return value;
    } catch {
        // falls through to the error below
    }
    throw new ConfigError(`${key}: ${value} is not a directory`);
}

// The file `relative` names under `root` and its media type; undefined for anything else, a directory, a dotfile or a path out of the root included.
export async function asset(root: string, relative: string): Promise<{ body: Buffer; type: string } | undefined> {
    const segments = relative.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment.startsWith(".") || segment.includes("\0") || segment.includes("\\"))) return undefined;
    try {
        const base = await realpath(root);
        const file = await realpath(path.join(base, ...segments));
        const found = await stat(file);
        return !file.startsWith(`${base}${path.sep}`) || !found.isFile() ? undefined : { body: await readFile(file), type: MEDIA[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream" };
    } catch {
        return undefined;
    }
}
