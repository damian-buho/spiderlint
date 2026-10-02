// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Parser } from "htmlparser2";
import type { Content } from "./feed-model.ts";

export type ContentProblem = "raw-markup" | "template-leak" | "relative-url" | "unsafe-html" | "double-escaped" | "content-type";

const SAMPLE = 60;
const LITERAL = new Set(["pre", "code", "kbd", "samp", "script", "style"]);
const UNSAFE = new Set(["script", "iframe", "object", "embed", "form", "frame", "frameset", "applet", "base", "meta", "link"]);
const URL_ATTRIBUTES: Record<string, string[]> = { a: ["href"], img: ["src", "srcset"], source: ["src", "srcset"], video: ["src", "poster"], audio: ["src"], iframe: ["src"], link: ["href"] };

// Markdown signs, each counted once per item; two different signs make it Markdown.
const MARKDOWN: [string, RegExp][] = [
    ["heading", /^#{1,6}[ \t]+\S/m],
    ["bold", /\*\*[^*\n]+\*\*/],
    ["fence", /^```/m],
    ["link", /\[[^\]\n]+\]\((?:https?:|\/|\.\/|#)[^)\s]*\)/],
    ["list", /^[ \t]*[-*+][ \t]+\S.*\n[ \t]*[-*+][ \t]+\S/m],
    ["front matter", /^---\n(?:[\w-]+:.*\n)+---/],
];
const MDX_STATEMENT = /^[ \t]*(?:import\s+[\w{}\s,*]+\s+from\s+["'][^"']+["']|export\s+(?:const|default|function)\s)/m;
const MDX_EXPRESSION = /(?<![{$])\{(?!\{)[ \t]*[A-Za-z_$][\w$.]*(?:\([^)]*\))?[ \t]*\}(?!\})/;
const TEMPLATE = /\{\{[^}]*\}\}|\{%[^%]*%\}|\$\{[^}]*\}|\[object Object\]/;
const NULLISH = /^(?:undefined|null|NaN)$/;
const ESCAPED_TAG = /<\/?(?:p|a|div|span|br|img|em|strong|ul|ol|li|h[1-6]|blockquote|figure|code|pre)\b[^>]*>/i;
const ESCAPED_ENTITY = /&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+|[a-z]+);/i;
const MOJIBAKE = /Ã[\u{80}-\u{BF}]|â€[\u{80}-\u{BF}™œ“”˜]/u;

// The line of `text` holding the match of `pattern`.
const lineOf = (text: string, pattern: RegExp) => {
    const index = pattern.exec(text)?.index ?? 0;
    const end = text.indexOf("\n", index);
    return text.slice(text.lastIndexOf("\n", index) + 1, end === -1 ? undefined : end);
};

const clip = (text: string) => {
    const flat = text.replaceAll(/\s+/g, " ").trim();
    return flat.length > SAMPLE ? `${flat.slice(0, SAMPLE - 1)}…` : flat;
};

// Whether a URL attribute value resolves on its own, without the feed’s or the page’s address.
const isAbsolute = (value: string) => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value.trim()) || value.trim() === "";

// Problems of one HTML or text body, each a short sample; HTML is parsed, never matched as a whole.
export function judgeContent(content: Content): Partial<Record<ContentProblem | "mojibake", string[]>> {
    const found: Partial<Record<ContentProblem | "mojibake", string[]>> = {};
    const add = (problem: ContentProblem | "mojibake", sample: string) => {
        const list = (found[problem] ??= []);
        if (!list.includes(sample)) list.push(sample);
    };
    const prose: string[] = [];
    if (content.type === "text") {
        prose.push(content.value);
        if (/<\/?[a-z][a-z\d]*(?:\s[^<>]*)?>/i.test(content.value)) add("content-type", `${content.field} is plain text but holds tags`);
    } else {
        const literal: string[] = [];
        let element = "";
        let buffer = "";
        // Judges the text gathered since the last tag, since the parser hands each decoded entity over on its own.
        const flush = () => {
            const text = buffer;
            buffer = "";
            if (!text) return;
            prose.push(text);
            if (element && NULLISH.test(text.trim())) add("template-leak", `<${element}>${text.trim()}</${element}>`);
            if (ESCAPED_TAG.test(text)) add("double-escaped", clip(ESCAPED_TAG.exec(text)?.[0] ?? text));
            if (ESCAPED_ENTITY.test(text)) add("double-escaped", ESCAPED_ENTITY.exec(text)?.[0] ?? text);
        };
        const parser = new Parser(
            {
                onopentag(name, attributes) {
                    flush();
                    const lower = name.toLowerCase();
                    element = lower;
                    if (LITERAL.has(lower)) literal.push(lower);
                    if (/^[A-Z]/.test(name) && literal.length === 0) add("raw-markup", `<${name}>`);
                    if (UNSAFE.has(lower)) add("unsafe-html", `<${lower}>`);
                    for (const [attribute, value] of Object.entries(attributes)) {
                        if (/^on[a-z]+$/i.test(attribute)) add("unsafe-html", `${attribute} on <${lower}>`);
                        if (attribute === "style" && /position\s*:\s*(?:fixed|absolute)/i.test(value)) add("unsafe-html", `positioned style on <${lower}>`);
                        if (URL_ATTRIBUTES[lower]?.includes(attribute.toLowerCase()) && !content.base && value.split(",").some((part) => !isAbsolute(part.trim().split(/\s+/, 1)[0] ?? ""))) add("relative-url", `${attribute}="${clip(value)}"`);
                    }
                },
                ontext(text) {
                    if (literal.length === 0) buffer += text;
                },
                onclosetag(name) {
                    flush();
                    if (literal.at(-1) === name.toLowerCase()) literal.pop();
                    element = "";
                },
            },
            { lowerCaseTags: false, lowerCaseAttributeNames: false, decodeEntities: true, recognizeSelfClosing: true },
        );
        parser.write(content.value);
        parser.end();
        flush();
    }
    const text = prose.join("");
    if (MDX_STATEMENT.test(text)) add("raw-markup", clip(MDX_STATEMENT.exec(text)?.[0] ?? ""));
    if (MDX_EXPRESSION.test(text)) add("raw-markup", clip(MDX_EXPRESSION.exec(text)?.[0] ?? ""));
    const signs = MARKDOWN.filter(([, pattern]) => pattern.test(text));
    if (signs.length >= 2) add("raw-markup", `Markdown ${signs.map(([name]) => name).join(", ")}: ${clip(lineOf(text, signs[0]?.[1] ?? /^/))}`);
    if (TEMPLATE.test(text)) add("template-leak", clip(TEMPLATE.exec(text)?.[0] ?? ""));
    if (MOJIBAKE.test(text)) add("mojibake", clip(MOJIBAKE.exec(text)?.[0] ?? ""));
    return found;
}

// Problems of an item title, which every format holds as plain text unless Atom says otherwise.
export function judgeTitle(title: string, type: string): string[] {
    if (!title.trim()) return ["empty title"];
    if (type !== "text") return [];
    const tag = /<\/?[a-z][a-z\d]*(?:\s[^<>]*)?>/i.exec(title)?.[0];
    const entity = ESCAPED_ENTITY.exec(title)?.[0];
    return [...(tag ? [`tag ${tag}`] : []), ...(entity ? [`entity ${entity}`] : []), ...(TEMPLATE.test(title) || NULLISH.test(title.trim()) ? [`template ${clip(title)}`] : [])];
}

// Visible words of a body, to compare an item with the page it links.
export function wordsOf(content: Content): number {
    const text = content.type === "text" ? content.value : content.value.replaceAll(/<[^>]*>/g, " ");
    return text.split(/\s+/).filter(Boolean).length;
}
