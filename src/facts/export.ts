// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import picomatch from "picomatch";
import { stringify } from "yaml";
import { plain, type Paint } from "../color.ts";
import { ConfigError } from "../config/index.ts";
import { relative, singleOrigin } from "../crawl/scope.ts";
import { log } from "../logger.ts";
import { field } from "../report/csv.ts";
import { aligned, measure, statRows } from "../report/human.ts";
import { printable } from "../report/printable.ts";
import { factStats } from "../report/stats.ts";
import { byRank, flatten, type Scalar } from "./flatten.ts";
import type { Facts, SiteFacts } from "./types.ts";

export const FACT_FORMATS = ["human", "json", "yaml", "csv"];

// The columns `export-facts` shows a person when `--facts` picks none.
const SHOWN = ["http.status", "co2.grams", "http.size.body", "resources.length", "http.timing.total"];

// Widest path column before values stop lining up, so one long key cannot push every value off screen.
const PATH_WIDTH = 40;

// Columns every row starts with whatever `--facts` picks, the rest follow ranked.
const LEADING = new Set(["url.href", "group"]);

// Each page flattened, by URL, and the ranked scalar paths `picks` matches beside `url.href` and `group`; `fallback` when nothing is picked.
function tabled(pages: Facts[], picks: string[], fallback?: string[]): { rows: Record<string, Scalar>[]; paths: string[] } {
    const rows = pages.map((page) => flatten(page)).toSorted((a, b) => String(a["url.href"]).localeCompare(String(b["url.href"])));
    const isPicked = picks.length > 0 ? picomatch(picks, { dot: true }) : () => true;
    const found = new Set(rows.flatMap((row) => Object.keys(row)).filter((path) => !LEADING.has(path) && isPicked(path)));
    const paths = fallback && picks.length === 0 ? fallback : [...found].toSorted(byRank);
    log.debug({ pages: rows.length, picks, columns: paths.length }, "facts table built");
    return { rows, paths };
}

// One row per page and one column per scalar fact path `picks` matches (all without), arrays as their `.length`; site facts are left out.
function toCsv(pages: Facts[], picks: string[]): string {
    const { rows, paths } = tabled(pages, picks);
    const columns = [...LEADING, ...paths];
    return [columns.map((column) => field(column)).join(","), ...rows.map((row) => columns.map((column) => field(row[column])).join(","))].join("\r\n");
}

// Every leaf by dotted path, a list of plain values on one line (a dash when empty) and a list of objects numbered.
function leaves(value: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
    if (Array.isArray(value) && value.every((entry) => entry === null || typeof entry !== "object")) out.push([prefix.slice(0, -1), value.length === 0 ? "–" : value.join(", ")]);
    else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) leaves(child, `${prefix}${key}.`, out);
    else if (value !== undefined) out.push([prefix.slice(0, -1), String(value)]);
    return out;
}

// One page and its site as aligned `path  value` lines, every site string made printable.
function pageText(page: Facts | undefined, site: SiteFacts, paint: Paint): string {
    const lines = leaves({ ...page, site }).map(([path, value]) => [printable(path), printable(value)] as const);
    const width = Math.min(PATH_WIDTH, Math.max(0, ...lines.map(([path]) => path.length)));
    return lines.map(([path, value]) => `${paint("cyan", path.padEnd(width))}  ${value}`).join("\n");
}

// A table cell: a number measured, text made printable, absent as a dash.
function cell(value: Scalar | undefined): string {
    if (value === undefined) return "–";
    return typeof value === "number" ? measure(value) : printable(String(value));
}

// One row per page under the shared origin, then the statistics of its numeric columns.
function pagesText(pages: Facts[], picks: string[], paint: Paint): string {
    const origin = singleOrigin(pages.map((page) => page.url.href));
    const { rows, paths } = tabled(pages, picks, SHOWN);
    const table = [["page", "group", ...paths.map((path) => printable(path))], ...rows.map((row) => [printable(relative(String(row["url.href"]), origin)), printable(String(row.group)), ...paths.map((path) => cell(row[path]))])];
    const stats = Object.fromEntries(Object.entries(factStats(pages)).filter(([path]) => paths.includes(path)));
    return [...(origin ? [paint(["bold", "underline"], origin)] : []), ...aligned(table, paint), "", ...statRows(stats, paint)].join("\n");
}

// One page as the document it always was, with the site under `site`; several pages as `pages` beside `site`; `human` as lines and tables.
export function formatFacts(pages: Facts[], site: SiteFacts, format: string, picks: string[], isOne: boolean, paint: Paint = plain): string {
    if (!["human", "csv"].includes(format) && picks.length > 0) throw new ConfigError(`--facts: picks human and csv columns only, not ${format}`);
    if (format === "csv") return toCsv(pages, picks);
    if (format === "human") return isOne ? pageText(pages[0], site, paint) : pagesText(pages, picks, paint);
    const document = isOne ? { ...pages[0], site } : { pages, site };
    return format === "yaml" ? stringify(document) : JSON.stringify(document, undefined, 2);
}
