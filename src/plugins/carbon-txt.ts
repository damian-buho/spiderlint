// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { parse } from "smol-toml";
import { log } from "../logger.ts";

// Syntax versions carbontxt.org has published; refreshed by hand from https://carbontxt.org/syntax.
export const VERSIONS = new Set(["0.1", "0.2", "0.3", "0.4", "0.5"]);
// Disclosure `doc_type` values of syntax 0.5.
export const DOC_TYPES = new Set(["web-page", "annual-report", "sustainability-page", "certificate", "csrd-report", "ai-model-card", "other"]);

const DAY_MS = 86_400_000;
const RFC_3339 = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

export interface CarbonVerdict {
    errors: string[];
    fields?: Record<string, unknown>;
    // Disclosure URLs to link-check.
    links: string[];
    // Disclosures past their `valid_until`.
    expired?: string[];
    // Days since `last_updated`.
    "age-days"?: number;
}

// TOML values as JSON keeps them: a date as its ISO string.
function plain(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item) => plain(item));
    return isTable(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)])) : value;
}

function isTable(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

// A TOML date, or a string in RFC 3339 form, as epoch milliseconds; undefined when it is neither.
function dateOf(value: unknown): number | undefined {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
    if (typeof value !== "string" || !RFC_3339.test(value)) return undefined;
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time;
}

// Records `name` when present and not a date.
function checkDate(value: unknown, name: string, errors: string[]): number | undefined {
    if (value === undefined) return undefined;
    const time = dateOf(value);
    if (time === undefined) errors.push(`${name} ${String(value)} is not a TOML date or RFC 3339 string`);
    return time;
}

// One disclosure’s defects, its URL when it has one, and whether its `valid_until` has passed.
function disclosure(item: unknown, where: string, errors: string[], now: number): { url?: string; isExpired: boolean } {
    if (!isTable(item)) {
        errors.push(`${where} is not a table`);
        return { isExpired: false };
    }
    if (item.doc_type === undefined) errors.push(`${where}.doc_type missing`);
    else if (!DOC_TYPES.has(String(item.doc_type))) errors.push(`${where}.doc_type ${String(item.doc_type)} is not one of ${[...DOC_TYPES].join(", ")}`);
    const url = typeof item.url === "string" ? item.url : undefined;
    if (item.url === undefined) errors.push(`${where}.url missing`);
    else if (!url || !/^https?:\/\//i.test(url) || !URL.canParse(url)) errors.push(`${where}.url ${String(item.url)} is not an http: or https: URL`);
    const until = checkDate(item.valid_until, `${where}.valid_until`, errors);
    return { ...(url && URL.canParse(url) && /^https?:/i.test(url) && { url }), isExpired: until !== undefined && until < now };
}

// carbon.txt syntax 0.5, one line per defect, with the fields worth keeping.
export function checkCarbonTxt(text: string, now = Date.now()): CarbonVerdict {
    const errors: string[] = [];
    let data: Record<string, unknown>;
    try {
        data = parse(text) as Record<string, unknown>;
    } catch (error) {
        return { errors: [`not TOML: ${(error instanceof Error ? error.message : String(error)).split("\n", 1)[0]}`], links: [] };
    }
    if (data.version === undefined) errors.push("version missing");
    else if (!VERSIONS.has(String(data.version))) errors.push(`version ${String(data.version)} is unknown`);
    const updated = checkDate(data.last_updated, "last_updated", errors);
    const org = isTable(data.org) ? data.org : undefined;
    if (!org && data.org !== undefined) errors.push("org is not a table");
    const disclosures = org?.disclosures;
    if (!Array.isArray(disclosures) || disclosures.length === 0) errors.push("org.disclosures missing or empty");
    const judged = (Array.isArray(disclosures) ? disclosures : []).map((item, index) => ({ item, ...disclosure(item, `org.disclosures[${index}]`, errors, now) }));
    const upstream = isTable(data.upstream) ? data.upstream : undefined;
    if (!upstream && data.upstream !== undefined) errors.push("upstream is not a table");
    const services = upstream?.services;
    if (services !== undefined && !Array.isArray(services)) errors.push("upstream.services is not an array");
    const listed = Array.isArray(services) ? services : [];
    for (const [index, service] of listed.entries()) if (!isTable(service)) errors.push(`upstream.services[${index}] is not a table`);
    const links = judged.flatMap(({ url }) => (url ? [url] : []));
    const expired = judged.flatMap(({ url, isExpired, item }) => (isExpired ? [url ?? String((item as Record<string, unknown>).url)] : []));
    log.debug({ version: data.version, disclosures: judged.length, services: listed.length, errors: errors.length, expired: expired.length }, "carbon.txt checked");
    const fields = { version: data.version, ...(updated !== undefined && { last_updated: new Date(updated).toISOString() }), org: { disclosures: judged.map(({ item }) => item) }, upstream: { services: listed } };
    return { errors, fields: plain(fields) as Record<string, unknown>, links, expired, ...(updated !== undefined && { "age-days": Math.floor((now - updated) / DAY_MS) }) };
}
