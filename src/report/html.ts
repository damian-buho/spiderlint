// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import { bytes, label, withUnit } from "../facts/labels.ts";
import { environmentLanguage, translator, type Translator } from "../i18n.ts";
import type { Report } from "../index.ts";
import { byImportance, scoreOf } from "../rules/score.ts";
import type { Finding } from "../rules/types.ts";
import type { Paint } from "../color.ts";
import { bundle } from "./human.ts";

const ORDER = { error: 0, warning: 1, info: 2, hint: 3 };
const LIST = 5;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// The one stylesheet of the report and the server pages, inline so a saved report stands alone.
export const STYLE = `
:root { color-scheme: light dark; --fg: light-dark(#1b1b1f, #e6e6ea); --muted: light-dark(#5d5d66, #a3a3ad); --bg: light-dark(#fff, #16161a); --line: light-dark(#dcdce2, #34343c); --error: light-dark(#b3261e, #ff8a80); --warning: light-dark(#8a5a00, #ffcc66); --info: light-dark(#1d5fa8, #8ab4f8); --good: light-dark(#1e7a34, #7ee2a8); --mid: light-dark(#b45d00, #ffb870); }
* { box-sizing: border-box; }
body { margin: 0 auto; max-inline-size: 72rem; padding: 1.5rem; font: 1rem/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--info); overflow-wrap: anywhere; }
h1 { font-size: 1.5rem; margin-block: 0 .25rem; overflow-wrap: anywhere; }
h2 { font-size: 1.15rem; margin-block: 2rem .5rem; }
small, .muted { color: var(--muted); }
code { font-size: .9em; overflow-wrap: anywhere; }
.head { display: flex; gap: 1rem; align-items: center; }
.grade { display: grid; place-items: center; inline-size: 4rem; block-size: 4rem; flex: none; border-radius: .5rem; font-size: 2rem; font-weight: 700; color: var(--bg); background: var(--muted); margin: 0; }
.grade-S, .grade-A { background: var(--good); } .grade-B { background: var(--warning); } .grade-C, .grade-D { background: var(--mid); } .grade-E, .grade-F { background: var(--error); }
.totals { display: grid; grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr)); gap: .75rem; margin-block: 1.5rem; }
.totals div { border: 1px solid var(--line); border-radius: .5rem; padding: .5rem .75rem; }
.totals dt { color: var(--muted); font-size: .85rem; } .totals dd { margin: 0; font-weight: 600; }
table { inline-size: 100%; border-collapse: collapse; }
th, td { text-align: start; vertical-align: top; padding: .5rem; border-block-end: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .85rem; }
td:nth-child(2) code { white-space: nowrap; overflow-wrap: normal; }
.error { color: var(--error); } .warning { color: var(--warning); } .info { color: var(--info); } .hint { color: var(--muted); }
summary { cursor: pointer; } summary h2 { display: inline; }
ul { margin: .25rem 0 0; padding-inline-start: 1.25rem; }
form { display: flex; flex-wrap: wrap; gap: .5rem; margin-block: 1.5rem; }
input { flex: 1 1 20rem; font: inherit; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: .375rem; color: inherit; background: transparent; }
button { font: inherit; padding: .5rem 1.25rem; border: 0; border-radius: .375rem; color: var(--bg); background: var(--fg); cursor: pointer; }
progress { inline-size: 100%; block-size: .75rem; }
.alert { border-inline-start: .25rem solid var(--error); padding: .5rem 1rem; background: light-dark(#fdecea, #2c1614); }
`;

// `value` as HTML text or a quoted attribute.
export function escape(value: unknown): string {
    return String(value).replaceAll(/[&<>"']/g, (character) => ENTITIES[character] as string);
}

// A whole page in the translator’s language and direction.
export function page(t: Translator, title: string, body: string, head = ""): string {
    return `<!DOCTYPE html>\n<html lang="${t.lang}" dir="${t.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escape(title)}</title><style>${STYLE}</style>${head}</head><body>${body}</body></html>\n`;
}

// Translated severity names; the rule ID beside them is never translated.
function severityName(t: Translator, severity: Finding["severity"]): string {
    return { error: t._("Error"), warning: t._("Warning"), info: t._("Info"), hint: t._("Hint") }[severity];
}

// A link to a crawled http(s) URL, shown relative to the shared origin; anything else is plain text.
function link(url: string, origin: string): string {
    const text = escape(relative(url, origin) || url);
    return /^https?:\/\//i.test(url) ? `<a href="${escape(url)}" rel="nofollow noopener noreferrer">${text}</a>` : text;
}

// A list whose items past the first few fold into a disclosure.
function items(t: Translator, values: string[]): string {
    if (values.length === 0) return "";
    const shown = `<ul>${values.slice(0, LIST).map((value) => `<li>${value}</li>`).join("")}</ul>`;
    return values.length > LIST ? `${shown}<details><summary>${escape(t._("{count} more", { count: t.number(values.length - LIST) }))}</summary><ul>${values.slice(LIST).map((value) => `<li>${value}</li>`).join("")}</ul></details>` : shown;
}

// Locations under what they locate, as code.
function locations(t: Translator, found: string[] | undefined): string {
    return items(t, (found ?? []).map((location) => `<code>${escape(location)}</code>`));
}

// What a finding covers: a fold’s share and samples, an aggregate’s URLs, or the one page, each with its locations.
function detail(t: Translator, same: Finding[], origin: string): string {
    const [first] = same as [Finding];
    if (same.length > 1) return items(t, same.map((finding) => `${link(finding.url, origin)}${locations(t, finding.locations)}`));
    if (first.occurrences !== undefined) {
        const share = t.number(first.coverage ?? 0, { style: "percent" });
        const pages = first.sampled === undefined ? t._("Pages: {count} ({share})", { count: t.number(first.occurrences), share }) : t._("Sampled pages: {count} of {sampled} ({share})", { count: t.number(first.occurrences), sampled: t.number(first.sampled), share });
        return `<p class="muted">${escape(pages)}</p>${items(t, (first.samples ?? []).map((url) => `${link(url, origin)}${locations(t, first.sampleLocations?.[url])}`))}`;
    }
    return first.urls ? `${items(t, first.urls.map((url) => link(url, origin)))}${locations(t, first.locations)}` : `<div>${link(first.url, origin)}</div>${locations(t, first.locations)}`;
}

// One table row per bundle of findings.
function row(t: Translator, same: Finding[], origin: string): string {
    const [first] = same as [Finding];
    const message = origin ? first.message.replaceAll(`${origin}/`, "/") : first.message;
    return `<tr><td class="${first.severity}">${escape(severityName(t, first.severity))} ${scoreOf(first).toFixed(1)}</td><td><code>${escape(first.rule)}</code></td><td>${escape(message)}${detail(t, same, origin)}</td></tr>`;
}

// One summary cell.
function total(label: string, value: string, tone = ""): string {
    return `<div><dt>${escape(label)}</dt><dd${tone ? ` class="${tone}"` : ""}>${escape(value)}</dd></div>`;
}

// Severity, rule and finding columns, one row per bundle.
function table(t: Translator, findings: Finding[], origin: string): string {
    return `<table><thead><tr><th>${escape(t._("Severity"))}</th><th>${escape(t._("Rule"))}</th><th>${escape(t._("Finding"))}</th></tr></thead><tbody>${bundle(findings).map((same) => row(t, same, origin)).join("")}</tbody></table>`;
}

// A fact’s translated label with its path on hover, or the path as code when it has none.
function factName(t: Translator, path: string): string {
    const english = label(path);
    return english ? `<span title="${escape(path)}">${escape(t._(english))}</span>` : `<code>${escape(path)}</code>`;
}

// Every numeric fact’s pages, then min, median, p95, max and total in its unit, in a closed disclosure; nothing without statistics.
function statistics(t: Translator, stats: Report["summary"]["stats"] = {}): string {
    const rows = Object.entries(stats).map(([path, stat]) => `<tr><td>${factName(t, path)}</td><td>${escape(t.number(stat.count))}</td>${[stat.min, stat.median, stat.p95, stat.max, stat.total].map((value) => `<td>${escape(withUnit(path, value, t.number))}</td>`).join("")}</tr>`);
    const head = [t._("Fact"), t._("Pages"), t._("Minimum"), t._("Median"), t._("95th percentile"), t._("Maximum"), t._("Total")].map((label) => `<th>${escape(label)}</th>`).join("");
    return rows.length === 0 ? "" : `<section><details><summary><h2>${escape(t._("Statistics"))}</h2></summary><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></details></section>`;
}

// The rating, the totals and every finding grouped by group, site-wide ones next, each vendor’s last; findings keep their English message.
export function reportBody(report: Pick<Report, "summary" | "findings"> & { pages?: Report["pages"] }, t: Translator, title: string): string {
    const { summary } = report;
    const origin = singleOrigin([...(report.pages ?? []).map((facts) => facts.url.href), ...report.findings.map((finding) => finding.url)]);
    const { rating } = summary;
    const started = new Intl.DateTimeFormat(t.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.started));
    const head = `<header class="head"><p class="grade grade-${rating?.grade ?? "none"}" title="${escape(t._("Rating"))}">${escape(rating?.grade ?? "–")}</p><div><h1>${escape(title)}</h1><p class="muted">${escape(rating ? t._("Rulesets: {names}", { names: rating.rulesets.join(", ") }) : t._("No checks ran"))} · ${escape(started)}</p></div></header>`;
    const totals = [
        total(t._("Pages"), t.number(summary.pages)),
        total(t._("Size"), bytes(summary.bytes, t.number)),
        total(t._("Time"), t.number(summary.durationMs / 1000, { style: "unit", unit: "second" })),
        total(t._("Checks passed"), t._("{passed} of {total}", { passed: t.number(summary.checks.passed), total: t.number(summary.checks.total) })),
        ...(Object.keys(ORDER) as Finding["severity"][]).map((severity) => total(severityName(t, severity), t.number(summary.findings[severity] ?? 0), (summary.findings[severity] ?? 0) > 0 ? severity : "")),
    ];
    const groups = new Map<string, Finding[]>();
    const vendors = new Map<string, Finding[]>();
    const hints = report.findings.filter((finding) => finding.severity === "hint");
    for (const finding of report.findings) {
        if (finding.severity === "hint") continue;
        const [sections, key] = finding.vendor ? [vendors, finding.vendor] : [groups, finding.scope === "site" ? "" : (finding.group as string)];
        sections.set(key, [...(sections.get(key) ?? []), finding]);
    }
    const section = (heading: string, findings: Finding[]) => {
        findings.sort(byImportance(summary.pages));
        return `<section><h2>${heading}</h2>${table(t, findings, origin)}</section>`;
    };
    const groupHeading = (group: string) => (group === "" ? escape(t._("Whole site")) : `<code>${escape(group)}</code> <small>${escape(t._("Pages: {count}", { count: t.number(summary.groups[group] ?? 0) }))}</small>`);
    const sections = [
        ...[...groups].toSorted(([a], [b]) => Number(a === "") - Number(b === "")).map(([group, findings]) => section(groupHeading(group), findings)),
        ...[...vendors].map(([vendor, findings]) => section(escape(t._("Vendor: {name}", { name: vendor })), findings)),
    ];
    const heading = escape(t._("Hints: {count}", { count: t.number(hints.length) }));
    if (hints.length > 0) sections.push(`<section><details><summary><h2>${heading}</h2></summary>${table(t, hints.toSorted((a, b) => a.rule.localeCompare(b.rule) || a.url.localeCompare(b.url)), origin)}</details></section>`);
    return `${head}<dl class="totals">${totals.join("")}</dl>${sections.length > 0 ? sections.join("") : `<p>${escape(t._("No findings."))}</p>`}${statistics(t, summary.stats)}`;
}

// A standalone page in `lang`, the process locale unless named; colour and `isFull` do not apply, since every list folds into a disclosure.
export function formatHtml(report: Report, _paint?: Paint, _isFull?: boolean, lang = environmentLanguage()): string {
    const t = translator(lang);
    const origin = singleOrigin(report.pages.map((facts) => facts.url.href));
    const title = origin || t._("spiderlint report");
    return page(t, title, `<main>${reportBody(report, t, title)}</main>`);
}
