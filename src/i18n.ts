// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { po } from "gettext-parser";
import { log } from "./logger.ts";

// Languages with a catalog under `locales/`, English first as the source language.
export const LANGUAGES = ["en", "es", "uk"];

const LOCALES = new URL("../locales/", import.meta.url);
const catalogs = new Map<string, Map<string, string>>();

export interface Translator {
    lang: string;
    dir: "ltr" | "rtl";
    // The translation of `msgid`, `{name}` placeholders replaced from `variables`.
    _(msgid: string, variables?: Record<string, string | number>): string;
    number(value: number, options?: Intl.NumberFormatOptions): string;
}

// The catalog of `lang`, read once; a missing or broken file is an empty catalog, so strings stay English.
function catalog(lang: string): Map<string, string> {
    const cached = catalogs.get(lang);
    if (cached) return cached;
    const entries = new Map<string, string>();
    try {
        const parsed = po.parse(readFileSync(new URL(`${lang}/LC_MESSAGES/messages.po`, LOCALES)));
        const translations = Object.entries(parsed.translations[""] ?? {});
        for (const [msgid, entry] of translations) if (msgid && entry.msgstr[0]) entries.set(msgid, entry.msgstr[0]);
        log.debug({ lang, entries: entries.size }, "catalog loaded");
    } catch (error) {
        log.warn({ lang, error: String(error) }, `${lang} catalog not loaded, strings stay English:`);
    }
    catalogs.set(lang, entries);
    return entries;
}

// The best language an `Accept-Language` header or a POSIX locale (`uk_UA.UTF-8`) names, by q-value; English when none has a catalog.
export function negotiate(accept: string | undefined): string {
    const ranked = (accept ?? "").split(",").map((part) => {
        const [tag = "", ...parameters] = part.trim().split(";");
        const q = Number(parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="))?.slice(2) ?? 1);
        return { lang: tag.trim().toLowerCase().split(/[-_.@]/, 1)[0] ?? "", q: Number.isFinite(q) ? q : 0 };
    });
    const lang = ranked.filter((entry) => entry.q > 0).toSorted((a, b) => b.q - a.q).find((entry) => LANGUAGES.includes(entry.lang))?.lang ?? "en";
    log.debug({ accept, lang }, "language negotiated");
    return lang;
}

// The language the process environment names, as gettext reads it.
export function environmentLanguage(): string {
    return negotiate(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG);
}

// Strings, numbers and text direction in `lang`.
export function translator(lang: string): Translator {
    const entries = lang === "en" ? new Map<string, string>() : catalog(lang);
    const format = (options: Intl.NumberFormatOptions) => new Intl.NumberFormat(lang, { maximumFractionDigits: 1, ...options });
    return {
        lang,
        dir: (new Intl.Locale(lang) as Intl.Locale & { getTextInfo(): { direction: "ltr" | "rtl" } }).getTextInfo().direction,
        _: (msgid, variables = {}) => (entries.get(msgid) ?? msgid).replaceAll(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(variables, key) ? String(variables[key]) : match)),
        number: (value, options = {}) => format(options).format(value),
    };
}
