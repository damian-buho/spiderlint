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
    // The catalog language strings come from.
    lang: string;
    // The locale numbers, dates and units are written in: the reader’s own, catalog or not.
    locale: string;
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

// The language tags of an `Accept-Language` header or POSIX locale (`uk_UA.UTF-8`) with a positive q-value, best first.
function ranked(accept: string | undefined): string[] {
    const parts = (accept ?? "").split(",").map((part) => {
        const [tag = "", ...parameters] = part.trim().split(";");
        const q = Number(
            parameters
                .map((parameter) => parameter.trim())
                .find((parameter) => parameter.startsWith("q="))
                ?.slice(2) ?? 1,
        );
        return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0 };
    });
    return parts
        .filter((entry) => entry.q > 0 && entry.tag !== "")
        .toSorted((a, b) => b.q - a.q)
        .map((entry) => entry.tag);
}

// The best language `accept` names that has a catalog, by q-value; English when none has.
export function negotiate(accept: string | undefined): string {
    const lang =
        ranked(accept)
            .map((tag) => tag.toLowerCase().split(/[-_.@]/, 1)[0] ?? "")
            .find((tag) => LANGUAGES.includes(tag)) ?? "en";
    log.debug({ accept, lang }, "language negotiated");
    return lang;
}

// The first tag `accept` names that `Intl` can format, as a BCP 47 locale (`de-DE`); undefined when none.
export function readerLocale(accept: string | undefined): string | undefined {
    for (const tag of ranked(accept)) {
        const bare = tag.replace(/[.@].*$/, "").replaceAll("_", "-");
        if (["*", "c", "posix"].includes(bare.toLowerCase())) continue;
        try {
            const [locale] = Intl.getCanonicalLocales(bare);
            if (locale && Intl.NumberFormat.supportedLocalesOf(locale).length > 0) {
                log.debug({ accept, locale }, "reader locale chosen");
                return locale;
            }
        } catch {
            log.debug({ tag }, "language tag not a locale");
        }
    }
    return undefined;
}

// The language the process environment names, as gettext reads it.
export function environmentLanguage(): string {
    return negotiate(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG);
}

// The locale the process environment writes numbers in: `LC_NUMERIC`, then `LC_ALL`, then `LANG`.
export function environmentLocale(): string | undefined {
    return readerLocale(process.env.LC_NUMERIC || process.env.LC_ALL || process.env.LANG);
}

// Strings and text direction in `lang`; numbers, dates and units in `locale`, `lang` unless named.
export function translator(lang: string, locale: string = lang): Translator {
    const entries = lang === "en" ? new Map<string, string>() : catalog(lang);
    const format = (options: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1, ...options });
    return {
        lang,
        locale,
        dir: (new Intl.Locale(lang) as Intl.Locale & { getTextInfo(): { direction: "ltr" | "rtl" } }).getTextInfo().direction,
        _: (msgid, variables = {}) => (entries.get(msgid) ?? msgid).replaceAll(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(variables, key) ? String(variables[key]) : match)),
        number: (value, options = {}) => format(options).format(value),
    };
}
