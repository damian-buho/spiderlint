// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { relative, singleOrigin } from "../crawl/scope.ts";
import { fixFor } from "../rules/fix.ts";
import { bytes, isLabelled, label, withUnit } from "../facts/labels.ts";
import { environmentLanguage, environmentLocale, translator, type Translator } from "../i18n.ts";
import type { Report } from "../index.ts";
import { importance, scoreOf } from "../rules/score.ts";
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
:root { color-scheme: light dark; --fg: light-dark(#26231c, #ece7da); --muted: light-dark(#6a6454, #a99f88); --bg: light-dark(#f7f5ef, #13110d); --surface: light-dark(#fff, #1b1812); --line: light-dark(#e3ded0, #353025); --accent: light-dark(#7a5c21, #dccfa6); --error: light-dark(#b3261e, #ff8a80); --warning: light-dark(#8a5a00, #ffcc66); --info: light-dark(#1d5fa8, #8ab4f8); --good: light-dark(#1e7a34, #7ee2a8); --good-bg: light-dark(#eef7f0, #14231a); --good-line: light-dark(#b9dcc3, #25492f); --mid: light-dark(#b45d00, #ffb870); --gap: 1.5rem; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-inline-size: 68rem; padding: 0 var(--gap) 3rem; font: 1rem/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
a { color: var(--accent); overflow-wrap: anywhere; text-underline-offset: .2em; }
h1 { font-size: 1.75rem; line-height: 1.25; margin-block: 0 .5rem; overflow-wrap: anywhere; }
h2 { font-size: 1.25rem; margin-block: 3rem 1rem; }
h3 { font-size: .95rem; font-weight: 600; margin-block: 2rem .75rem; }
p { margin-block: 0 1rem; }
small, .muted { color: var(--muted); }
code { font-size: .9em; overflow-wrap: anywhere; }
main { padding-block: 2.5rem; }
.site { display: flex; flex-wrap: wrap; gap: 1rem 2rem; align-items: center; justify-content: space-between; padding-block: 1.5rem; border-block-end: 1px solid var(--line); }
.site nav { display: flex; gap: 1.5rem; }
.brand { display: inline-flex; gap: .75rem; align-items: center; color: var(--fg); font-size: 1.15rem; font-weight: 700; letter-spacing: .02em; text-decoration: none; }
.brand img { display: block; }
.site nav a, .foot a { text-decoration: none; } .site nav a:hover, .foot a:hover { text-decoration: underline; }
.foot { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; padding-block: 1.5rem; border-block-start: 1px solid var(--line); font-size: .9rem; color: var(--muted); }
.foot p { flex: 1 1 100%; margin: 0; }
.hero { display: flex; gap: 2rem; align-items: center; padding: 2rem; background: var(--surface); border: 1px solid var(--line); }
.hero p { margin: 0; }
.grade { display: grid; place-items: center; inline-size: 5.5rem; block-size: 5.5rem; flex: none; font-size: 2.75rem; font-weight: 700; color: var(--bg); background: var(--muted); }
.grade-S, .grade-A { background: var(--good); } .grade-B { background: var(--warning); } .grade-C, .grade-D { background: var(--mid); } .grade-E, .grade-F { background: var(--error); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 1rem; margin-block: 1rem; }
.kpi { padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--line); }
.kpi b { display: block; font-size: 1.5rem; line-height: 1.3; font-variant-numeric: tabular-nums; }
.kpi span { color: var(--muted); font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
.kpi.good { background: var(--good-bg); border-color: var(--good-line); } .kpi.good b { color: var(--good); }
.pills { display: flex; flex-wrap: wrap; gap: .5rem; margin-block-end: 0; }
.pill { padding: .25rem .75rem; border: 1px solid var(--line); font-size: .875rem; color: var(--muted); }
.pill.error, .pill.warning, .pill.info { background: var(--surface); }
.notice { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; align-items: center; justify-content: space-between; margin-block: 0 1.5rem; padding: 1rem 1.25rem; background: var(--surface); border: 1px solid var(--line); border-inline-start: .25rem solid var(--accent); }
.notice p { margin: 0; }
.button, button { display: inline-block; font: inherit; padding: .75rem 1.5rem; border: 0; color: var(--bg); background: var(--accent); text-decoration: none; cursor: pointer; }
.button:hover, button:hover { filter: brightness(1.1); }
.finding { margin-block: .5rem; background: var(--surface); border: 1px solid var(--line); }
.finding > summary { padding: 1rem 1.25rem; }
.finding > div { padding: 0 1.25rem 1rem 2.75rem; }
.finding p { margin-block: .5rem 0; }
.score { display: inline-block; min-inline-size: 6.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
.rule-card { margin-block: 1rem; background: var(--surface); border: 1px solid var(--line); border-inline-start: .25rem solid var(--muted); }
.rule-card.error { border-inline-start-color: var(--error); } .rule-card.warning { border-inline-start-color: var(--warning); } .rule-card.info { border-inline-start-color: var(--info); }
.rule-card.passed { border-inline-start-color: var(--good); } .rule-card.untested { opacity: .85; }
.rule-head { display: flex; align-items: baseline; gap: .75rem; padding: 1rem 1.25rem; list-style: none; }
.rule-card > summary::marker { content: ""; } .rule-card > summary::-webkit-details-marker { display: none; }
.rule-head .badge { flex: none; font-weight: 700; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; }
.rule-head code { flex: none; }
.rule-head .rule-message { overflow-wrap: anywhere; }
.rule-head .rule-arrow { margin-inline-start: auto; flex: none; color: var(--muted); }
.rule-findings { padding: 0 1.25rem .5rem; }
.rule-foot { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; justify-content: space-between; padding: .75rem 1.25rem; border-block-start: 1px solid var(--line); font-size: .85rem; color: var(--muted); }
table { inline-size: 100%; border-collapse: collapse; background: var(--surface); }
th, td { text-align: start; vertical-align: top; padding: .75rem 1rem; border-block-end: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: .85rem; }
.error { color: var(--error); } .warning { color: var(--warning); } .info { color: var(--info); } .hint { color: var(--muted); }
summary { cursor: pointer; } summary h2 { display: inline; margin: 0; }
ul { margin: .5rem 0 0; padding-inline-start: 1.25rem; }
.passed > details, .untested > details { background: var(--surface); border: 1px solid var(--line); }
.passed > details { background: var(--good-bg); border-color: var(--good-line); border-inline-start: .25rem solid var(--good); }
.passed summary, .untested summary { padding: 1.25rem 1.5rem; }
.passed h2 { color: var(--good); }
.passed ul, .untested .areas { margin: 0; padding: 0 1.5rem 1.5rem; list-style: none; }
.passed li { padding-block: .5rem; border-block-start: 1px solid var(--good-line); }
.passed li:first-child { border-block-start: 0; }
.tick { color: var(--good); font-weight: 700; }
.untested > details > p { margin: 0; padding-inline: 1.5rem; }
.areas { display: grid; gap: 1rem; margin-block-start: 1rem; }
.areas h3 { margin-block: 0 .5rem; color: var(--muted); font-weight: 500; }
.areas ul { display: flex; flex-wrap: wrap; gap: .5rem; padding: 0; list-style: none; }
.areas li { padding: .125rem .625rem; border: 1px solid var(--line); color: var(--muted); }
form { display: flex; flex-wrap: wrap; gap: .75rem; margin-block: 2rem; }
form label.muted { flex: 1 1 100%; }
fieldset { flex: 1 1 100%; border: 0; padding: 0; margin: 1rem 0 0; display: grid; gap: .5rem; } fieldset label { display: block; padding: .75rem 1rem; background: var(--surface); border: 1px solid var(--line); }
legend { padding: 0; }
input[type=radio] { flex: none; inline-size: auto; margin-inline-end: .5rem; }
input { flex: 1 1 20rem; font: inherit; padding: .75rem 1rem; border: 1px solid var(--line); color: inherit; background: var(--surface); }
progress { inline-size: 100%; block-size: .75rem; accent-color: var(--accent); }
.alert { border-inline-start: .25rem solid var(--error); padding: 1rem 1.25rem; background: light-dark(#fdecea, #2c1614); }
@media (max-width: 40rem) { .hero { flex-direction: column; align-items: flex-start; padding: 1.5rem; } body { padding-inline: 1rem; } }
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

// One collapsed line per bundle: score, message, subject; expanded, the pages, locations, fix and docs.
function entry(t: Translator, same: Finding[], origin: string, guides: Report["rules"], total: number): string {
    const [first] = same as [Finding];
    const { subject, isWhole, pages } = reach(t, same, origin, total);
    const message = origin ? first.message.replaceAll(`${origin}/`, "/") : first.message;
    const hasLocations = same.some((finding) => finding.locations?.length) || Object.keys(first.sampleLocations ?? {}).length > 0;
    const share = first.occurrences === undefined ? "" : `<p class="muted">${escape(first.sampled === undefined ? t._("Pages: {count} ({share})", { count: t.number(first.occurrences), share: t.number(first.coverage ?? 0, { style: "percent" }) }) : t._("Sampled pages: {count} of {sampled} ({share})", { count: t.number(first.occurrences), sampled: t.number(first.sampled), share: t.number(first.coverage ?? 0, { style: "percent" }) }))}</p>`;
    const own = same.length === 1 && first.occurrences === undefined ? locations(t, first.locations) : "";
    const listed = isWhole && !hasLocations ? "" : items(t, pages);
    return `<details class="finding"><summary><span class="score ${first.severity}">${escape(severityName(t, first.severity))} ${scoreOf(first).toFixed(1)}</span> ${escape(message)}${subject ? ` — ${link(subject, origin)}` : ""}</summary><div>${share}${listed}${own}${remedy(t, guides?.[first.rule], first)}</div></details>`;
}

// Pages one rule’s findings touch: a fold’s occurrences, an aggregate’s URLs, else one page per finding.
function touched(same: Finding[]): number {
    return same.reduce((sum, finding) => sum + (finding.occurrences ?? finding.urls?.length ?? 1), 0);
}

// One card per rule: severity and message in the header, the findings collapsed in the body, severity, impact and scope spread across the footer.
function ruleCard(t: Translator, same: Finding[], origin: string, guides: Report["rules"], total: number): string {
    const [first] = same as [Finding];
    const worst = same.toSorted((a, b) => ORDER[a.severity] - ORDER[b.severity] || scoreOf(b) - scoreOf(a))[0] as Finding;
    const impact = Math.max(...same.map((finding) => importance(finding, total)));
    const whole = touched(same) >= total || same.every((finding) => reach(t, [finding], origin, total).isWhole);
    const scope = whole && total > 0 ? t._("Whole site") : t._("Pages: {count}", { count: t.number(touched(same)) });
    const message = origin ? first.message.replaceAll(`${origin}/`, "/") : first.message;
    const extra = same.length > 1 ? ` <small class="muted">· ${escape(t._("{count} findings", { count: t.number(same.length) }))}</small>` : "";
    const foot = `<span>${escape(t._("Severity"))}: <span class="${worst.severity}">${escape(severityName(t, worst.severity))} ${scoreOf(worst).toFixed(1)}</span></span><span>${escape(t._("Impact"))}: ${escape(impact.toFixed(1))}</span><span>${escape(t._("Scope"))}: ${escape(scope)}</span>`;
    return `<details class="rule-card ${worst.severity}" open><summary class="rule-head"><span class="badge ${worst.severity}">${escape(severityName(t, worst.severity))}</span><code>${escape(first.rule)}</code><span class="rule-message">${escape(message)}${extra}</span><span class="rule-arrow" aria-hidden="true">▾</span></summary><div class="rule-findings">${bundle(same).map((bundled) => entry(t, bundled, origin, guides, total)).join("")}</div><footer class="rule-foot">${foot}</footer></details>`;
}

// Findings by rule, one card per rule, the most important rule first.
function rules(t: Translator, findings: Finding[], origin: string, guides: Report["rules"], total: number): string {
    return ordered(findings, total).map((same) => ruleCard(t, same, origin, guides, total)).join("");
}

// A fact’s translated label with its path on hover, or the path as code when it has none.
function factName(t: Translator, path: string): string {
    const english = label(path);
    return english ? `<span title="${escape(path)}">${escape(t._(english))}</span>` : `<code>${escape(path)}</code>`;
}

// Every labelled numeric fact’s pages, then min, median, p95, max and total in its unit, in a closed disclosure; nothing without statistics.
function statistics(t: Translator, stats: Report["summary"]["stats"] = {}): string {
    const rows = Object.entries(stats).filter(([path]) => isLabelled(path)).map(([path, stat]) => `<tr><td>${factName(t, path)}</td><td>${escape(t.number(stat.count))}</td>${[stat.min, stat.median, stat.p95, stat.max, stat.total].map((value) => `<td>${escape(value === undefined ? "–" : withUnit(path, value, t.number))}</td>`).join("")}</tr>`);
    const head = [t._("Fact"), t._("Pages"), t._("Minimum"), t._("Median"), t._("95th percentile"), t._("Maximum"), t._("Total")].map((label) => `<th>${escape(label)}</th>`).join("");
    return rows.length === 0 ? "" : `<section><details><summary><h2>${escape(t._("Statistics"))}</h2></summary><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></details></section>`;
}

// The rules that ran and failed nowhere, one green card per rule; nothing without any.
function passed(t: Translator, report: Pick<Report, "summary" | "rules">): string {
    const clean = passing(report.summary.checked);
    const rows = clean.map(([id, rule]) => {
        const fix = report.rules?.[id]?.fix;
        const body = fix ? `<div class="rule-findings"><p class="muted">${escape(fixFor(fix))}</p></div>` : "";
        const foot = `<span>${escape(t._("Severity"))}: –</span><span>${escape(t._("Impact"))}: ${(0).toFixed(1)}</span><span>${escape(t._("Scope"))}: ${escape(t._("Pages: {count}", { count: t.number(rule.pages) }))}</span>`;
        return `<details class="rule-card passed"><summary class="rule-head"><span class="tick" aria-hidden="true">✓</span><code>${escape(id)}</code><span class="rule-arrow" aria-hidden="true">▾</span></summary>${body}<footer class="rule-foot">${foot}</footer></details>`;
    });
    const counts = { rules: t.number(clean.length), pages: t.number(report.summary.pages), checks: t.number(clean.reduce((sum, [, rule]) => sum + rule.checks, 0)) };
    const heading = escape(t._("Passed: {rules} rules, {pages} pages, {checks} checks", counts));
    return rows.length === 0 ? "" : `<section class="passed"><details open><summary><h2>${heading}</h2></summary>${rows.join("")}</details></section>`;
}

// The shipped rules that judged nothing, one muted card per rule; nothing when every rule ran.
function untested(t: Translator, ids: string[] = []): string {
    if (ids.length === 0) return "";
    const rows = ids.map((id) => {
        const foot = `<span>${escape(t._("Severity"))}: –</span><span>${escape(t._("Impact"))}: –</span><span>${escape(t._("Scope"))}: –</span>`;
        return `<details class="rule-card untested"><summary class="rule-head"><code>${escape(id)}</code><span class="rule-arrow" aria-hidden="true">▾</span></summary><footer class="rule-foot">${foot}</footer></details>`;
    });
    const heading = escape(t._("Not tested: {count} rules", { count: t.number(ids.length) }));
    return `<section class="untested"><details><summary><h2>${heading}</h2></summary><p class="muted">${escape(t._("Rules this scan did not judge: its checks leave them out, or the site has nothing they apply to."))}</p>${rows.join("")}</details></section>`;
}

// The rating, the totals and every finding grouped by group, site-wide ones next, each vendor’s last; findings keep their English message.
export function reportBody(report: Pick<Report, "summary" | "findings" | "rules">, t: Translator, title: string, origin: string): string {
    const { summary } = report;
    const { rating } = summary;
    const started = new Intl.DateTimeFormat(t.locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(summary.started));
    const head = `<header class="hero"><p class="grade grade-${rating?.grade ?? "none"}" title="${escape(t._("Rating"))}">${escape(rating?.grade ?? "–")}</p><div><h1>${escape(title)}</h1><p class="muted">${escape(rating ? t._("Rulesets: {names}", { names: rating.rulesets.join(", ") }) : t._("No checks ran"))} · ${escape(started)}</p></div></header>`;
    const kpi = (value: string, name: string, tone = "") => `<div class="kpi${tone && ` ${tone}`}"><b>${escape(value)}</b><span>${escape(name)}</span></div>`;
    const measured = [
        kpi(t.number(summary.pages), t._("Pages")),
        kpi(bytes(summary.bytes, t.number), t._("Size")),
        kpi(t.number(summary.durationMs / 1000, { style: "unit", unit: "second" }), t._("Time")),
        kpi(t._("{passed} of {total}", { passed: t.number(summary.checks.passed), total: t.number(summary.checks.total) }), t._("Checks passed"), "good"),
    ];
    const counted = (Object.keys(ORDER) as Finding["severity"][]).map((severity) => {
        const count = summary.findings[severity] ?? 0;
        return `<span class="pill${count > 0 ? ` ${severity}` : ""}">${escape(`${severityName(t, severity)}: ${t.number(count)}`)}</span>`;
    });
    const totals = `<div class="kpis">${measured.join("")}</div><p class="pills">${counted.join("")}</p>`;
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
    return `${head}${totals}${sections.length > 0 ? sections.join("") : `<p>${escape(t._("No findings."))}</p>`}${passed(t, report)}${statistics(t, summary.stats)}${untested(t, summary.untested)}`;
}

// A standalone page in `lang`, the process locale unless named; colour and `isFull` do not apply, since every list folds into a disclosure.
export function formatHtml(report: Report, _paint?: Paint, _isFull?: boolean, lang?: string): string {
    const t = lang === undefined ? translator(environmentLanguage(), environmentLocale()) : translator(lang);
    const origin = singleOrigin(report.pages.map((facts) => facts.url.href));
    const title = origin || t._("spiderlint report");
    return page(t, title, `<main>${reportBody(report, t, title, origin)}</main>`);
}
