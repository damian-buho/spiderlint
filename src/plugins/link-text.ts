// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { load } from "cheerio";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule } from "../rules/builtin.ts";
import { definePlugin } from "./types.ts";

const ID = "linktext";

// Link texts that say nothing about their target, per primary language subtag; a language absent here is never judged.
const GENERIC: Record<string, string[]> = {
    en: ["click here", "click", "here", "read more", "more", "learn more", "more info", "more information", "see more", "details", "continue", "continue reading", "link", "this link", "this", "go"],
    es: ["haz clic aquí", "clic aquí", "pulsa aquí", "aquí", "leer más", "más", "saber más", "más información", "ver más", "detalles", "continuar", "seguir leyendo", "enlace", "este enlace"],
    uk: ["натисніть тут", "тут", "читати далі", "читати більше", "детальніше", "докладніше", "більше", "дізнатися більше", "ще", "продовжити", "посилання", "це посилання"],
};

export interface LinkTextFacts {
    locale: string;
    generic: { text: string; href: string }[];
}

// Lower-cased, trimmed of punctuation and arrows, whitespace collapsed.
function normalise(text: string, locale: string): string {
    return text
        .toLocaleLowerCase(locale)
        .replaceAll(/\s+/g, " ")
        .trim()
        .replaceAll(/[\p{P}\p{S}\s]+$|^[\p{P}\p{S}\s]+/gu, "");
}

// Anchors whose accessible name is a generic phrase of the page’s language; a language with no list adds nothing.
async function extract(page: Facts, body: string): Promise<LinkTextFacts | undefined> {
    if (!page.html) return;
    const locale = page.html.lang?.split("-", 1)[0]?.toLowerCase();
    const phrases = locale ? GENERIC[locale] : undefined;
    if (!locale || !phrases) {
        log.debug({ url: page.url.href, lang: page.html.lang }, "link text skipped: no phrase list for the language");
        return;
    }
    const known = new Set(phrases);
    const $ = load(body);
    const labelled = (ids: string) =>
        ids
            .split(/\s+/)
            .map((id) => $(`[id="${id.replaceAll('"', String.raw`\"`)}"]`).text())
            .join(" ");
    const generic = $("a[href]")
        .get()
        .flatMap((element) => {
            const anchor = $(element);
            const alt = anchor
                .find("img[alt]")
                .map((_, img) => $(img).attr("alt"))
                .get()
                .join(" ");
            const name = anchor.attr("aria-labelledby") ? labelled(String(anchor.attr("aria-labelledby"))) : (anchor.attr("aria-label") ?? `${anchor.text()} ${alt}`);
            const text = normalise(name, locale);
            return known.has(text) ? [{ text, href: String(anchor.attr("href")) }] : [];
        });
    log.debug({ url: page.url.href, locale, generic: generic.length }, "link text read");
    return { locale, generic };
}

const generic = pageRule(
    "link-text/generic",
    [`${ID}.generic`],
    (page) => {
        const facts = page[ID] as LinkTextFacts | undefined;
        if (!facts) return;
        const count = facts.generic.length;
        return count === 0 ? [] : [{ message: `${count} link${count === 1 ? " says" : "s say"} nothing about ${count === 1 ? "its target" : "their targets"} out of context`, value: facts.generic, locations: facts.generic.map(({ text, href }) => `“${text}” → ${href}`) }];
    },
    { docs: "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html", fix: "Name the target in the link text itself, or give the link an `aria-label` that does." },
);

export default definePlugin({
    name: "link-text",
    extractors: [{ id: ID, extract }],
    rules: { "link-text/generic": generic },
    presets: {
        "link-text": {
            description: "Links whose text says where they lead, judged in the page’s own language: English, Spanish and Ukrainian",
            rules: { "link-text/generic": { severity: "warning", score: 4.6 } },
        },
    },
});
