// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseDictionary, parseItem, parseList, Token, DisplayString, type BareItem, type InnerList, type Item } from "structured-headers";
import { log } from "../logger.ts";
import type { ParsedHeader } from "./types.ts";

type Parser = (text: string, errors: string[], headers?: Record<string, string | string[] | undefined>) => unknown;

// RFC 9110 §5.6.2 token.
const TOKEN = String.raw`[!#$%&'*+.^_\x60|~0-9A-Za-z-]+`;
// RFC 9110 §5.6.4 quoted-string.
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const FIELD_NAME = new RegExp(`^${TOKEN}$`);
const PARAMETER = new RegExp(`^(${TOKEN})=(${TOKEN}|${QUOTED})$`);
const DIRECTIVE = new RegExp(`^(${TOKEN})(?:=(${TOKEN}|${QUOTED}))?$`);
// RFC 6797 §6.1 allows whitespace around `=`.
const SPACED_DIRECTIVE = new RegExp(String.raw`^(${TOKEN})\s*(?:=\s*(${TOKEN}|${QUOTED}))?$`);

// A token or quoted-string argument, unquoted.
const unquote = (text: string): string => (text.startsWith('"') ? text.slice(1, -1).replaceAll(/\\(.)/g, "$1") : text);

// Elements of a comma list, commas inside quoted strings kept; empty elements dropped as RFC 9110 §5.6.1 allows.
function elements(text: string, separator = ","): string[] {
    return (text.match(new RegExp(`(?:${QUOTED}|[^"${separator}])+`, "g")) ?? []).map((part) => part.trim()).filter((part) => part.length > 0);
}

// Cache-Control directives by argument: seconds, an optional field list, none; request-only ones never belong in a response (RFC 9111 §5.2, RFC 5861, RFC 8246).
const SECONDS = new Set(["max-age", "s-maxage", "stale-while-revalidate", "stale-if-error"]);
const FIELDS = new Set(["no-cache", "private"]);
const BARE = new Set(["public", "no-store", "no-transform", "must-revalidate", "proxy-revalidate", "must-understand", "immutable"]);
const REQUEST = new Set(["max-stale", "min-fresh", "only-if-cached"]);

// Each well-formed directive once, lower-cased with its argument unquoted; a malformed or repeated one is an error.
function directives(parts: string[], pattern: RegExp, errors: string[]): [string, string | undefined][] {
    const found = new Map<string, string | undefined>();
    for (const part of parts) {
        const match = pattern.exec(part);
        const name = match?.[1]?.toLowerCase();
        if (name === undefined) errors.push(`“${part}” is not a directive`);
        else if (found.has(name)) errors.push(`${name} is given twice`);
        else found.set(name, match?.[2] && unquote(match[2]));
    }
    return [...found];
}

// A delta-seconds argument as a number, else an error.
function seconds(name: string, argument: string | undefined, errors: string[]): number | undefined {
    if (argument !== undefined && /^\d+$/.test(argument)) return Number(argument);
    errors.push(`${name} needs a number of seconds, got ${argument ?? "none"}`);
    return undefined;
}

// RFC 9111 §5.2: `token [ "=" ( token / quoted-string ) ]`, each directive once, from the registry.
const cacheControl: Parser = (text, errors) => {
    const value: Record<string, number | true | string[] | undefined> = {};
    const found = directives(elements(text), DIRECTIVE, errors);
    for (const [name, argument] of found) {
        if (REQUEST.has(name)) errors.push(`${name} is a request directive`);
        else if (SECONDS.has(name)) value[name] = seconds(name, argument, errors);
        else if (FIELDS.has(name)) value[name] = argument === undefined || elements(argument).map((field) => field.toLowerCase());
        else if (argument === undefined && BARE.has(name)) value[name] = true;
        else errors.push(BARE.has(name) ? `${name} takes no argument` : `${name} is not a registered directive`);
    }
    return value;
};

// RFC 6797 §6.1: `;`-separated directives, each once, with a delta-seconds max-age; any violation makes the browser ignore the header.
const hsts: Parser = (text, errors) => {
    const value = Object.fromEntries(directives(elements(text, ";"), SPACED_DIRECTIVE, errors).map(([name, argument]) => [name, name === "max-age" ? seconds(name, argument, errors) : (argument ?? true)]));
    if (errors.length === 0 && !Object.hasOwn(value, "max-age")) errors.push("max-age is missing");
    return value;
};

// RFC 9110 §12.5.5: `*` or field names.
const vary: Parser = (text, errors) => {
    const names = elements(text);
    errors.push(...names.filter((name) => !FIELD_NAME.test(name)).map((name) => `“${name}” is not a field name`));
    return names.map((name) => name.toLowerCase());
};

// RFC 9110 §8.3.1: `type/subtype`, then `;`-separated `name=value` parameters.
const contentType: Parser = (text, errors) => {
    const [media = "", ...parameters] = elements(text, ";");
    if (!new RegExp(`^${TOKEN}/${TOKEN}$`).test(media)) errors.push(`“${media}” is not a type/subtype`);
    const values: Record<string, string> = {};
    for (const parameter of parameters) {
        const match = PARAMETER.exec(parameter);
        if (match) values[(match[1] as string).toLowerCase()] = unquote(match[2] as string);
        else errors.push(`“${parameter}” is not a name=value parameter`);
    }
    return { type: media.toLowerCase(), parameters: values };
};

// RFC 9110 §10.2.3: delay-seconds, or an IMF-fixdate whose weekday and day exist, as its UTC form round-trips.
const retryAfter: Parser = (text, errors, headers) => {
    if (/^\d+$/.test(text)) return { seconds: Number(text) };
    const time = Date.parse(text);
    if (Number.isNaN(time) || new Date(time).toUTCString() !== text) {
        errors.push(`“${text}” is neither a number of seconds nor an IMF-fixdate`);
        return;
    }
    const sent = Date.parse([headers?.date ?? []].flat()[0] ?? "");
    // A date becomes seconds after the response’s own Date, when it has one.
    return { date: time / 1000, ...(!Number.isNaN(sent) && { seconds: (time - sent) / 1000 }) };
};

// Referrer Policy §4.1 tokens; the browser applies the last it knows.
const REFERRER = new Set(["no-referrer", "no-referrer-when-downgrade", "same-origin", "origin", "strict-origin", "origin-when-cross-origin", "strict-origin-when-cross-origin", "unsafe-url"]);

const referrerPolicy: Parser = (text, errors) => {
    const tokens = elements(text).map((token) => token.toLowerCase());
    errors.push(...tokens.filter((token) => !REFERRER.has(token)).map((token) => `${token} is not a referrer policy`));
    return tokens.findLast((token) => REFERRER.has(token));
};

// CSP 3 and Trusted Types directives, with those taking a source list.
const SOURCE_LISTS = new Set(["child-src", "connect-src", "default-src", "fenced-frame-src", "font-src", "frame-src", "img-src", "manifest-src", "media-src", "object-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem", "style-src-attr", "worker-src", "base-uri", "form-action", "frame-ancestors"]);
const OTHER_DIRECTIVES = new Set(["sandbox", "report-uri", "report-to", "require-trusted-types-for", "trusted-types", "upgrade-insecure-requests", "webrtc"]);
const KEYWORDS = new Set(["'none'", "'self'", "'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "'unsafe-hashes'", "'report-sample'", "'unsafe-allow-redirects'", "'wasm-unsafe-eval'", "'inline-speculation-rules'", "'report-sha256'"]);
// CSP 3 §2.3.1 nonce-source, hash-source, scheme-source and host-source.
const SOURCE = /^(?:'nonce-[\w+/=-]+'|'sha(?:256|384|512)-[\w+/=-]+'|[a-z][\d+.a-z-]*:|(?:[a-z][\d+.a-z-]*:\/\/)?(?:\*|(?:\*\.)?[\da-z-]+(?:\.[\da-z-]+)*)(?::(?:\d+|\*))?(?:\/[^\s,;]*)?)$/i;

// CSP 3 §2.2.1: unknown directives and malformed sources, which the browser drops while enforcing the rest.
const csp: Parser = (text, errors) =>
    elements(text).map((policy) => {
        const directives: Record<string, string[]> = {};
        for (const part of elements(policy, ";")) {
            const [name = "", ...sources] = part.split(/\s+/);
            const key = name.toLowerCase();
            if (Object.hasOwn(directives, key)) errors.push(`${key} is given twice, and the second is ignored`);
            else if (!SOURCE_LISTS.has(key) && !OTHER_DIRECTIVES.has(key)) errors.push(`${key} is not a directive`);
            else if (key === "upgrade-insecure-requests" && sources.length > 0) errors.push(`${key} takes no value`);
            else if (SOURCE_LISTS.has(key)) {
                errors.push(
                    ...sources.filter((source) => !KEYWORDS.has(source.toLowerCase()) && !SOURCE.test(source)).map((source) => `${key} source ${source} is malformed`),
                    ...sources.filter((source) => KEYWORDS.has(`'${source.toLowerCase()}'`)).map((source) => `${key} source ${source} needs single quotes, else it names a host`),
                );
                if (sources.length > 1 && sources.some((source) => source.toLowerCase() === "'none'")) errors.push(`${key} has 'none' beside other sources`);
            }
            directives[key] ??= sources;
        }
        return directives;
    });

// An RFC 9651 bare item as JSON: tokens and display strings as strings, dates as Unix seconds, bytes as base64.
function bare(item: BareItem): unknown {
    if (item instanceof Token || item instanceof DisplayString) return item.toString();
    if (item instanceof Date) return item.getTime() / 1000;
    return item instanceof ArrayBuffer ? Buffer.from(item).toString("base64") : item;
}

// A member as JSON, parameters dropped: an inner list becomes an array.
const member = ([value]: Item | InnerList): unknown => (Array.isArray(value) ? value.map(([item]) => bare(item)) : bare(value));

// Checks a parsed member against a header’s own vocabulary.
type Vocabulary = (key: string, value: unknown, errors: string[]) => void;

// An RFC 9651 field of the given top-level type; a parse failure makes the recipient ignore the whole field.
function structured(type: "dictionary" | "list" | "item", vocabulary?: Vocabulary): Parser {
    return (text, errors) => {
        try {
            if (type === "item") {
                const value = bare(parseItem(text)[0]);
                vocabulary?.("", value, errors);
                return value;
            }
            if (type === "list") return parseList(text).map((entry) => member(entry));
            const value = Object.fromEntries([...parseDictionary(text)].map(([key, entry]) => [key, member(entry)]));
            for (const [key, entry] of Object.entries(value)) vocabulary?.(key, entry, errors);
            return value;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
            return;
        }
    };
}

// A token that must be one of `allowed`.
const oneOf =
    (...allowed: string[]): Vocabulary =>
    (_key, value, errors) => {
        if (typeof value !== "string" || !allowed.includes(value)) errors.push(`${String(value)} is not one of ${allowed.join(", ")}`);
    };

// Permissions Policy §5.2: `*`, `self`, `src` or an origin string, alone or in an inner list.
const allowlist: Vocabulary = (key, value, errors) => {
    for (const entry of [value].flat()) {
        const isOrigin = typeof entry === "string" && URL.canParse(entry) && /^https?:$/.test(new URL(entry).protocol);
        if (!isOrigin && !["*", "self", "src"].includes(String(entry))) errors.push(`${key} allows ${String(entry)}, which is neither *, self, src nor an origin`);
    }
};

// Reporting API §3.2: each endpoint is a URL string.
const endpoints: Vocabulary = (key, value, errors) => {
    if (typeof value !== "string") errors.push(`${key} is not a quoted URL`);
};

// RFC 9218 §4: urgency an integer 0–7, incremental a boolean.
const urgency: Vocabulary = (key, value, errors) => {
    if (key === "u" && !(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 7)) errors.push(`u is ${String(value)}, not an urgency from 0 to 7`);
    if (key === "i" && typeof value !== "boolean") errors.push(`i is ${String(value)}, not a boolean`);
};

// Header name → parser; a header absent from the table is not parsed.
const PARSERS: Record<string, Parser> = {
    "cache-control": cacheControl,
    "strict-transport-security": hsts,
    vary,
    "content-type": contentType,
    "referrer-policy": referrerPolicy,
    "retry-after": retryAfter,
    "content-security-policy": csp,
    "permissions-policy": structured("dictionary", allowlist),
    "reporting-endpoints": structured("dictionary", endpoints),
    "use-as-dictionary": structured("dictionary"),
    "accept-ch": structured("list"),
    priority: structured("dictionary", urgency),
    "cache-status": structured("list"),
    "cross-origin-opener-policy": structured("item", oneOf("unsafe-none", "same-origin-allow-popups", "same-origin", "noopener-allow-popups")),
    "cross-origin-embedder-policy": structured("item", oneOf("unsafe-none", "require-corp", "credentialless")),
};

// Each known header of a response parsed to `value`, or to `errors` alone when it breaks its grammar.
export function parsedHeaders(url: string, headers: Record<string, string | string[] | undefined>): Record<string, ParsedHeader> | undefined {
    const parsed: Record<string, ParsedHeader> = {};
    for (const [name, parse] of Object.entries(PARSERS)) {
        const raw = headers[name];
        if (raw === undefined) continue;
        const errors: string[] = [];
        const value = parse([raw].flat().join(", "), errors, headers);
        parsed[name] = value !== undefined && errors.length === 0 ? { value, errors } : { errors };
        if (errors.length > 0) log.debug({ url, header: name, errors }, "header breaks its grammar");
    }
    return Object.keys(parsed).length > 0 ? parsed : undefined;
}

// A Cache-Control value parsed alone, for resource rules.
export function parseCacheControl(text: string): ParsedHeader {
    const errors: string[] = [];
    const value = cacheControl(text, errors);
    return errors.length === 0 ? { value, errors } : { errors };
}
