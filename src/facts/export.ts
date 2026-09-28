// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import picomatch from "picomatch";
import { stringify } from "yaml";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { field } from "../report/csv.ts";
import { byRank, flatten } from "./flatten.ts";
import type { Facts, SiteFacts } from "./types.ts";

export const FACT_FORMATS = ["json", "yaml", "csv"];

// Columns every row starts with whatever `--facts` picks, the rest follow ranked.
const LEADING = new Set(["url.href", "group"]);

// One row per page and one column per scalar fact path `picks` matches (all without), arrays as their `.length`; site facts are left out.
function toCsv(pages: Facts[], picks: string[]): string {
    const rows = pages.map((page) => flatten(page)).toSorted((a, b) => String(a["url.href"]).localeCompare(String(b["url.href"])));
    const isPicked = picks.length > 0 ? picomatch(picks, { dot: true }) : () => true;
    const paths = new Set(rows.flatMap((row) => Object.keys(row)).filter((path) => !LEADING.has(path) && isPicked(path)));
    const columns = [...LEADING, ...[...paths].toSorted(byRank)];
    log.debug({ pages: rows.length, picks, columns: columns.length }, "facts table built");
    return [columns.map((column) => field(column)).join(","), ...rows.map((row) => columns.map((column) => field(row[column])).join(","))].join("\r\n");
}

// One page as the document it always was, with the site under `site`; several pages as `pages` beside `site`.
export function formatFacts(pages: Facts[], site: SiteFacts, format: string, picks: string[], isOne: boolean): string {
    if (format !== "csv" && picks.length > 0) throw new ConfigError(`--facts: picks csv columns only, not ${format} (add --format csv)`);
    if (format === "csv") return toCsv(pages, picks);
    const document = isOne ? { ...pages[0], site } : { pages, site };
    return format === "yaml" ? stringify(document) : JSON.stringify(document, undefined, 2);
}
