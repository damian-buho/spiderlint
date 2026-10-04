// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import { fixFor } from "../rules/fix.ts";
import { bytes, label, withUnit } from "../facts/labels.ts";
import { environmentLanguage, translator, type Translator } from "../i18n.ts";
import type { Report } from "../index.ts";
import { scoreOf } from "../rules/score.ts";
import type { Finding, RuleGuide } from "../rules/types.ts";
import type { Paint } from "../color.ts";
import { ordered } from "./agent.ts";
import { bundle } from "./human.ts";
import { passing } from "./rating.ts";

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
.totals p { margin: 0; }
h3 { font-size: 1rem; margin-block: 1rem .25rem; }
.finding { border-block-end: 1px solid var(--line); padding-block: .25rem; }
.finding > div { padding-inline-start: 1.25rem; }
.score { display: inline-block; min-inline-size: 6.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
table { inline-size: 100%; border-collapse: collapse; }
th, td { text-align: start; vertical-align: top; padding: .5rem; border-block-end: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .85rem; }
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

// What a bundle names, how many pages it spans and those pages, each with its locations.
function reach(t: Translator, same: Finding[], origin: string, total: number): { subject: string; count?: number; isWhole: boolean; pages: string[] } {
    const [first] = same as [Finding];
    const at = (url: string, found?: string[]) => `${link(url, origin)}${locations(t, found)}`;
    if (same.length > 1) return { subject: "", count: same.length, isWhole: total > 0 && same.length >= total, pages: same.map((finding) => at(finding.url, finding.locations)) };
    if (first.occurrences !== undefined) return { subject: "", count: first.occurrences, isWhole: (first.coverage ?? 0) >= 1, pages: (first.samples ?? []).map((url) => at(url, first.sampleLocations?.[url])) };
    if (first.urls) return { subject: first.urls.includes(first.url) ? "" : first.url, count: first.urls.length, isWhole: total > 0 && first.urls.length >= total, pages: first.urls.map((url) => link(url, origin)) };
    return { subject: first.url, isWhole: first.scope === "site", pages: [] };
}

// The rule’s fix filled for this finding, then its docs link; nothing when the rule has neither.
function remedy(t: Translator, guide: RuleGuide | undefined, finding: Finding): string {
    const fix = guide?.fix ? `<p>${escape(t._("Fix: {fix}", { fix: fixFor(guide.fix, finding) }))}</p>` : "";
    const documentation = guide?.docs && /^https?:\/\//i.test(guide.docs) ? `<p><a href="${escape(guide.docs)}" rel="noopener noreferrer">${escape(t._("Documentation"))}</a></p>` : "";
    return fix + documentation;
}

// One collapsed line per bundle: score, message, subject, scope; expanded, the pages, locations, fix and docs.
function entry(t: Translator, same: Finding[], origin: string, guides: Report["rules"], total: number): string {
    const [first] = same as [Finding];
    const { subject, count, isWhole, pages } = reach(t, same, origin, total);
    const message = origin ? first.message.replaceAll(`${origin}/`, "/") : first.message;
    const scope = isWhole ? t._("Whole site") : count === undefined ? "" : t._("Pages: {count}", { count: t.number(count) });
    const hasLocations = same.some((finding) => finding.locations?.length) || Object.keys(first.sampleLocations ?? {}).length > 0;
    const share = first.occurrences === undefined ? "" : `<p class="muted">${escape(first.sampled === undefined ? t._("Pages: {count} ({share})", { count: t.number(first.occurrences), share: t.number(first.coverage ?? 0, { style: "percent" }) }) : t._("Sampled pages: {count} of {sampled} ({share})", { count: t.number(first.occurrences), sampled: t.number(first.sampled), share: t.number(first.coverage ?? 0, { style: "percent" }) }))}</p>`;
    const own = same.length === 1 && first.occurrences === undefined ? locations(t, first.locations) : "";
    const listed = isWhole && !hasLocations ? "" : items(t, pages);
    return `<details class="finding"><summary><span class="score ${first.severity}">${escape(severityName(t, first.severity))} ${scoreOf(first).toFixed(1)}</span> ${escape(message)}${subject ? ` — ${link(subject, origin)}` : ""}${scope ? ` <small class="muted">· ${escape(scope)}</small>` : ""}</summary><div>${share}${listed}${own}${remedy(t, guides?.[first.rule], first)}</div></details>`;
}

// Findings by rule, each rule’s ID once as a heading over its collapsed lines, the most important rule first.
function rules(t: Translator, findings: Finding[], origin: string, guides: Report["rules"], total: number): string {
    return ordered(findings, total).map((same) => `<h3><code>${escape((same[0] as Finding).rule)}</code></h3>${bundle(same).map((bundled) => entry(t, bundled, origin, guides, total)).join("")}`).join("");
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

// The rules that ran and failed nowhere, closed: a green check, the rule, what it expects and the pages it covered; nothing without any.
function passed(t: Translator, report: Pick<Report, "summary" | "rules">): string {
    const rows = passing(report.summary.checked).map(([id, rule]) => {
        const fix = report.rules?.[id]?.fix;
        return `<li><span class="good" aria-hidden="true">✓</span> <code>${escape(id)}</code>${fix ? ` <small class="muted">${escape(fixFor(fix))}</small>` : ""} <small class="muted">· ${escape(t._("Pages: {count}", { count: t.number(rule.pages) }))}</small></li>`;
    });
    const heading = escape(t._("Passed: {count} checks", { count: t.number(report.summary.checks.passed) }));
    return rows.length === 0 ? "" : `<section><details><summary><h2>${heading}</h2></summary><ul>${rows.join("")}</ul></details></section>`;
}

// The rating, the totals and every finding grouped by group, site-wide ones next, each vendor’s last; findings keep their English message.
export function reportBody(report: Pick<Report, "summary" | "findings" | "rules">, t: Translator, title: string, origin: string): string {
    const { summary } = report;
    const { rating } = summary;
    const started = new Intl.DateTimeFormat(t.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.started));
    const head = `<header class="head"><p class="grade grade-${rating?.grade ?? "none"}" title="${escape(t._("Rating"))}">${escape(rating?.grade ?? "–")}</p><div><h1>${escape(title)}</h1><p class="muted">${escape(rating ? t._("Rulesets: {names}", { names: rating.rulesets.join(", ") }) : t._("No checks ran"))} · ${escape(started)}</p></div></header>`;
    const measured = [
        `${t._("Pages")}: ${t.number(summary.pages)}`,
        `${t._("Size")}: ${bytes(summary.bytes, t.number)}`,
        `${t._("Time")}: ${t.number(summary.durationMs / 1000, { style: "unit", unit: "second" })}`,
        `${t._("Checks passed")}: ${t._("{passed} of {total}", { passed: t.number(summary.checks.passed), total: t.number(summary.checks.total) })}`,
    ];
    const counted = (Object.keys(ORDER) as Finding["severity"][]).map((severity) => {
        const text = escape(`${severityName(t, severity)}: ${t.number(summary.findings[severity] ?? 0)}`);
        return (summary.findings[severity] ?? 0) > 0 ? `<span class="${severity}">${text}</span>` : text;
    });
    const totals = `<div class="totals"><p>${measured.map((text) => escape(text)).join(" · ")}</p><p>${counted.join(" · ")}</p></div>`;
    const groups = new Map<string, Finding[]>();
    const vendors = new Map<string, Finding[]>();
    const hints = report.findings.filter((finding) => finding.severity === "hint");
    for (const finding of report.findings) {
        if (finding.severity === "hint") continue;
        const [sections, key] = finding.vendor ? [vendors, finding.vendor] : [groups, finding.scope === "site" ? "" : (finding.group as string)];
        sections.set(key, [...(sections.get(key) ?? []), finding]);
    }
    const section = (heading: string, findings: Finding[]) => `<section>${heading && `<h2>${heading}</h2>`}${rules(t, findings, origin, report.rules, summary.pages)}</section>`;
    const isOnlyDefault = groups.keys().every((group) => group === "" || group === "default") && Object.keys(summary.groups).length <= 1;
    const groupHeading = (group: string) => (group === "" ? escape(t._("Whole site")) : isOnlyDefault ? "" : escape(t._("Group: {name} · Pages: {count}", { name: group, count: t.number(summary.groups[group] ?? 0) })));
    const sections = [
        ...[...groups].toSorted(([a], [b]) => Number(a === "") - Number(b === "")).map(([group, findings]) => section(groupHeading(group), findings)),
        ...[...vendors].map(([vendor, findings]) => section(escape(t._("Vendor: {name}", { name: vendor })), findings)),
    ];
    const heading = escape(t._("Hints: {count}", { count: t.number(hints.length) }));
    if (hints.length > 0) sections.push(`<section><details><summary><h2>${heading}</h2></summary>${rules(t, hints, origin, report.rules, summary.pages)}</details></section>`);
    return `${head}${totals}${sections.length > 0 ? sections.join("") : `<p>${escape(t._("No findings."))}</p>`}${passed(t, report)}${statistics(t, summary.stats)}`;
}

// A standalone page in `lang`, the process locale unless named; colour and `isFull` do not apply, since every list folds into a disclosure.
export function formatHtml(report: Report, _paint?: Paint, _isFull?: boolean, lang = environmentLanguage()): string {
    const t = translator(lang);
    const origin = singleOrigin(report.pages.map((facts) => facts.url.href));
    const title = origin || t._("spiderlint report");
    return page(t, title, `<main>${reportBody(report, t, title, origin)}</main>`);
}
