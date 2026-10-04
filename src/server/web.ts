// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { domainToUnicode } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { negotiate, readerLocale, translator, type Translator } from "../i18n.ts";
import { log } from "../logger.ts";
import { formatNames } from "../plugins/index.ts";
import type { Phase, Progress } from "../progress.ts";
import type { Grade } from "../report/rating.ts";
import { escape, page, reportBody, STYLE } from "../report/html.ts";
import { jobOf, submit, type Jobs } from "./jobs.ts";
import { presetSettings, presetsOffered, Refusal } from "./policy.ts";
import { latestKey, type ScanJob } from "./queue.ts";

const BODY_MAX = 64 * 1024;
const REFRESH_S = 5;
const BADGE_MAX_AGE_S = 300;
const GRADE_COLOR: Record<Grade | "none", string> = { S: "#1e7a34", A: "#1e7a34", B: "#8a6d00", C: "#b45d00", D: "#b45d00", E: "#b3261e", F: "#b3261e", none: "#6b6b75" };

// Progress over server-sent events, for a browser that runs scripts; without them the page refreshes itself.
const SCRIPT = String.raw`
const status = document.querySelector("[data-events]");
if (status && "EventSource" in window) {
    const lang = status.dataset.locale;
    const numbers = new Intl.NumberFormat(lang);
    const phases = JSON.parse(status.dataset.phases);
    const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
    const left = (eta) => {
        const units = new Intl.NumberFormat(lang, { style: "unit", unit: eta.unit });
        if (eta.low === 0) return fill(status.dataset.under, { range: units.format(eta.high) });
        return fill(status.dataset.eta, { range: eta.low === eta.high ? units.format(eta.high) : units.formatRange(eta.low, eta.high) });
    };
    const events = new EventSource(status.dataset.events);
    events.addEventListener("progress", (event) => {
        const job = JSON.parse(event.data);
        if (job.status === "running") status.querySelector("[data-state]").textContent = status.dataset.running;
        if (!job.progress) return;
        const { done, total, eta, phase, step } = job.progress;
        Object.assign(status.querySelector("progress"), { max: total, value: done });
        status.querySelector("[data-count]").textContent = fill(status.dataset.count, { done: numbers.format(done), total: numbers.format(total) });
        status.querySelector("[data-eta]").textContent = eta ? left(eta) : "";
        status.querySelector("[data-phase]").textContent = phase === "crawl" || !phases[phase] ? "" : step ? fill(status.dataset.step, { phase: phases[phase], done: numbers.format(step.done), total: numbers.format(step.total) }) : phases[phase];
    });
    for (const name of ["done", "failed", "expired"]) events.addEventListener(name, () => { events.close(); location.reload(); });
}
`;

const hash = (source: string) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;

// The policy of every page: its own stylesheet and script, same-origin images, events and forms, nothing else.
export const PAGE_CSP = `default-src 'none'; style-src ${hash(STYLE)}; script-src ${hash(SCRIPT)}; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

// A refusal in the reader’s words; `code` picks the sentence, the English message stays for logs.
function refusalText(t: Translator, refusal: Refusal): string {
    const when = refusal.retryAfter === undefined ? "" : relative(t, refusal.retryAfter);
    const texts: Record<string, string> = {
        "invalid-url": t._("Enter a web address, such as example.com."),
        "invalid-body": t._("The form could not be read. Try again."),
        "cross-site": t._("The form was sent from another site. Open this page and try again."),
        banned: t._("Scans of this site are disabled on this instance."),
        "no-policy": t._("This instance does not scan this site."),
        "forbidden-rule": t._("A requested rule is not available on this instance."),
        "unknown-rule": t._("A requested rule is not available on this instance."),
        "forbidden-fetch": t._("The requested fetch mode is not available on this instance."),
        "rate-limited": t._("This site was scanned recently. Try again {when}.", { when }),
        "client-rate-limited": t._("You have started many scans. Try again {when}.", { when }),
        "queue-full": t._("Too many scans are waiting. Try again {when}.", { when }),
        "not-found": t._("This scan does not exist or has expired."),
    };
    return texts[refusal.code] ?? t._("Something went wrong. Try again later.");
}

// `seconds` from now as the reader says it: “in 5 minutes”.
function relative(t: Translator, seconds: number): string {
    const format = new Intl.RelativeTimeFormat(t.lang, { numeric: "auto" });
    if (seconds < 90) return format.format(seconds, "second");
    return seconds < 90 * 60 ? format.format(Math.round(seconds / 60), "minute") : format.format(Math.round(seconds / 3600), "hour");
}

// The seed as a reader writes it: an international domain in its own script.
function shown(url: string): string {
    const parsed = new URL(url);
    return `${parsed.protocol}//${domainToUnicode(parsed.hostname) || parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}${decodeURI(parsed.pathname)}${parsed.search}`;
}

// A domain or a URL as typed, as the http(s) URL to scan; a bare domain is https.
function seedOf(raw: unknown): string {
    const typed = typeof raw === "string" ? raw.trim() : "";
    return typed === "" || /^[a-z][\d+.a-z-]*:\/\//i.test(typed) ? typed : `https://${typed}`;
}

// The page in the reader’s language, never cached, under the page policy.
function respond(c: Context, t: Translator, title: string, body: string, status: ContentfulStatusCode = 200, head = ""): Response {
    c.header("content-security-policy", PAGE_CSP);
    c.header("cache-control", "no-cache");
    c.header("vary", "accept-language");
    return c.html(page(t, title, body, head), status);
}

// What each web preset is called and says, in the reader’s language.
function presetText(t: Translator): Record<string, [name: string, summary: string]> {
    return {
        recommended: [t._("Standard"), t._("The recommended checks")],
        "web-quick": [t._("Quick"), t._("The basics over HTTP, on at most 25 pages")],
        "web-comprehensive": [t._("Comprehensive"), t._("The recommended checks plus link graph, structured data, manifest, trackers and more")],
    };
}

// The presets as a radio group, `chosen` or else the first checked; nothing when no policy offers one.
function presetChoice(t: Translator, offered: string[], chosen?: string): string {
    if (offered.length === 0) return "";
    const checked = chosen !== undefined && offered.includes(chosen) ? chosen : offered[0];
    const text = presetText(t);
    const options = offered.map((name) => `<label><input type="radio" name="preset" value="${escape(name)}"${name === checked ? " checked" : ""}> ${escape(text[name]?.[0] ?? name)} <small class="muted">${escape(text[name]?.[1] ?? "")}</small></label>`);
    return `<fieldset><legend class="muted">${escape(t._("Checks"))}</legend>${options.join("")}</fieldset>`;
}

// The form, with the address typed, the preset chosen and the refusal it met, if any.
function formPage(c: Context, t: Translator, offered: string[], typed = "", refusal?: Refusal, chosen?: string): Response {
    if (refusal?.retryAfter !== undefined) c.header("retry-after", String(refusal.retryAfter));
    const alert = refusal ? `<p class="alert" role="alert">${escape(refusalText(t, refusal))}${refusal.code === "banned" ? `<br><small>${escape(refusal.message)}</small>` : ""}</p>` : "";
    const body = `<main><h1>spiderlint</h1><p>${escape(t._("Checks every page of a site: search engine tags, security headers, TLS, links and more."))}</p>${alert}<form method="post" action="/"><label for="url" class="muted">${escape(t._("Site address"))}</label><input id="url" name="url" type="text" inputmode="url" autocomplete="url" required spellcheck="false" placeholder="example.com" value="${escape(typed)}"${refusal ? ' aria-invalid="true"' : ""}><button type="submit">${escape(t._("Scan"))}</button>${presetChoice(t, offered, chosen)}</form><p class="muted"><small>${escape(t._("Scans obey robots.txt and identify themselves as spiderlint. A finished report is public: its link and the site’s badge lead to it."))}</small></p></main>`;
    return respond(c, t, t._("spiderlint — site linter"), body, refusal?.status ?? 200);
}

// The time left as the reader writes it: “about 2–4 min”, “less than 3 min” while the low end is zero.
function etaLine(t: Translator, eta: Progress["eta"]): string {
    if (!eta) return "";
    const units = new Intl.NumberFormat(t.locale, { style: "unit", unit: eta.unit });
    if (eta.low === 0) return t._("Less than {range} left", { range: units.format(eta.high) });
    return t._("About {range} left", { range: eta.low === eta.high ? units.format(eta.high) : units.formatRange(eta.low, eta.high) });
}

// What each phase after the crawl is called, in the reader’s language.
function phaseNames(t: Translator): Partial<Record<Phase, string>> {
    return { resources: t._("Checking linked resources"), probes: t._("Checking external links"), site: t._("Checking domain, mail and certificates"), lint: t._("Evaluating the rules") };
}

// Where a queued or running scan stands, updated by events or, without scripts, by a refresh.
function progressBody(t: Translator, job: ScanJob, status: string): string {
    const { done, total, eta, phase, step } = (typeof job.progress === "object" ? job.progress : {}) as Partial<Progress>;
    const count = t._("Pages: {done} of {total}", { done: "{done}", total: "{total}" });
    const stepText = t._("{phase}: {done} of {total}", { phase: "{phase}", done: "{done}", total: "{total}" });
    const names = phaseNames(t);
    const named = phase && names[phase];
    const phaseText = named ? (step ? t._("{phase}: {done} of {total}", { phase: named, done: t.number(step.done), total: t.number(step.total) }) : named) : "";
    const state = status === "running" ? t._("Scanning…") : t._("Waiting in the queue…");
    const values = total === undefined ? "" : ` max="${total}" value="${done ?? 0}"`;
    const attributes = [["events", `/v1/jobs/${job.id}/events`], ["locale", t.locale], ["running", t._("Scanning…")], ["count", count], ["eta", t._("About {range} left", { range: "{range}" })], ["under", t._("Less than {range} left", { range: "{range}" })], ["step", stepText], ["phases", JSON.stringify(names)]].map(([name, value]) => `data-${name}="${escape(value as string)}"`).join(" ");
    const rulesets = (job.data.settings?.rules as string[] | undefined)?.join(", ");
    return `<div ${attributes}><p data-state>${escape(state)}</p>${rulesets ? `<p class="muted">${escape(t._("Rulesets: {names}", { names: rulesets }))}</p>` : ""}<progress${values}></progress><p><span data-count>${total === undefined ? "" : escape(t._("Pages: {done} of {total}", { done: t.number(done ?? 0), total: t.number(total) }))}</span> <span data-eta class="muted">${escape(etaLine(t, eta))}</span></p><p data-phase class="muted">${escape(phaseText)}</p></div>`;
}

// The report with its downloads and badge.
function doneBody(t: Translator, job: ScanJob): string {
    const downloads = formatNames().map((name) => `<a href="/v1/jobs/${escape(job.id)}/report/${escape(name)}">${escape(name)}</a>`).join(" · ");
    const badge = `/badge/${escape(job.data.host)}.svg`;
    return `${reportBody(job.returnvalue, t, shown(job.data.url), new URL(job.data.url).origin)}<h2>${escape(t._("Downloads"))}</h2><p>${downloads}</p><h2>${escape(t._("Badge"))}</h2><p><a href="${badge}"><img src="${badge}" alt="${escape(t._("Rating badge"))}"></a></p>`;
}

// Pixels a badge half needs for `text` in 11px Verdana, roughly.
function width(text: string): number {
    return 12 + [...text].length * 7;
}

// The reader’s strings from the request’s Accept-Language, and its numbers in the first locale it names.
function translate(c: Context): Translator {
    const accept = c.req.header("accept-language");
    return translator(negotiate(accept), readerLocale(accept));
}

// The form fields, or none when the body cannot be read.
async function formOf(c: Context): Promise<Record<string, unknown>> {
    try {
        return await c.req.parseBody();
    } catch (error) {
        log.debug({ error: String(error) }, "form not parsed");
        return {};
    }
}

// An SVG badge of `value` beside the tool name, linking to `href` when opened on its own.
function badge(value: string, color: string, href?: string): string {
    const label = "spiderlint";
    const [left, right] = [width(label), width(value)];
    const text = `<rect width="${left}" height="20" fill="#3c3c44"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${left / 2}" y="14">${label}</text><text x="${left + right / 2}" y="14">${escape(value)}</text></g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${left + right}" height="20" role="img" aria-label="${escape(`${label}: ${value}`)}"><title>${escape(`${label}: ${value}`)}</title>${href ? `<a href="${escape(href)}" target="_top">${text}</a>` : text}</svg>`;
}

// The form, the job pages and the badge, rendered on the server and complete without scripts.
export function web(jobs: Jobs): Hono {
    const app = new Hono();

    const offered = () => presetsOffered(jobs.settings());

    app.get("/", (c) => formPage(c, translate(c), offered()));

    app.post("/", bodyLimit({ maxSize: BODY_MAX, onError: (c) => formPage(c, translate(c), offered(), "", new Refusal(400, "invalid-body", "form too large")) }), async (c) => {
        const t = translate(c);
        const form = await formOf(c);
        const typed = typeof form.url === "string" ? form.url : "";
        const preset = typeof form.preset === "string" ? form.preset : undefined;
        try {
            if (c.req.header("sec-fetch-site") === "cross-site") throw new Refusal(403, "cross-site", "form sent from another site");
            const { job, isRepeat } = await submit(jobs, { url: seedOf(typed), ...(preset !== undefined && { settings: presetSettings(preset) }) }, c);
            log.debug({ job: job.id, isRepeat, preset }, "form submitted");
            return c.redirect(`/jobs/${job.id}`, 303);
        } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            log.info({ code: error.code, status: error.status, preset }, "form refused");
            return formPage(c, t, offered(), typed, error, preset);
        }
    });

    app.get("/jobs/:id", async (c) => {
        const t = translate(c);
        let job: ScanJob;
        try {
            job = await jobOf(jobs.queue, c.req.param("id"));
        } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            return respond(c, t, t._("Scan not found"), `<main><h1>${escape(t._("Scan not found"))}</h1><p>${escape(refusalText(t, error))}</p><p><a href="/">${escape(t._("Start a new scan"))}</a></p></main>`, 404);
        }
        const state = await job.getState();
        const title = shown(job.data.url);
        log.debug({ job: job.id, state }, "job page rendered");
        if (state === "completed") return respond(c, t, title, `<main>${doneBody(t, job)}<p><a href="/">${escape(t._("Start a new scan"))}</a></p></main>`);
        if (state === "failed") return respond(c, t, title, `<main><h1>${escape(title)}</h1><p class="alert" role="alert">${escape(t._("The scan failed."))}</p><p><code>${escape(job.failedReason)}</code></p><p><a href="/">${escape(t._("Start a new scan"))}</a></p></main>`);
        const body = `<main><h1>${escape(title)}</h1>${progressBody(t, job, state === "active" ? "running" : "queued")}</main><script>${SCRIPT}</script>`;
        return respond(c, t, title, body, 200, `<noscript><meta http-equiv="refresh" content="${REFRESH_S}"></noscript>`);
    });

    app.get("/badge/:file", async (c) => {
        const file = c.req.param("file");
        const raw = file.endsWith(".svg") ? file.slice(0, -".svg".length).toLowerCase().replace(/\.$/, "") : "";
        const host = raw && URL.canParse(`http://${raw}/`) ? new URL(`http://${raw}/`).hostname : "";
        const id = host ? await jobs.redis.get(latestKey(host)) : undefined;
        const job = id ? ((await jobs.queue.getJob(id)) as ScanJob | undefined) : undefined;
        const grade = job?.returnvalue?.summary.rating?.grade;
        log.debug({ host, job: id, grade }, "badge served");
        c.header("content-type", "image/svg+xml; charset=utf-8");
        c.header("content-security-policy", "default-src 'none'");
        c.header("cache-control", `max-age=${BADGE_MAX_AGE_S}`);
        c.header("vary", "accept-language");
        const value = job ? (grade ?? "–") : translate(c)._("not scanned");
        return c.body(badge(value, GRADE_COLOR[grade ?? "none"], job ? `/jobs/${job.id}` : undefined));
    });

    return app;
}
