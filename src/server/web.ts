// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { domainToUnicode } from "node:url";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { routePath } from "hono/route";
import { LICENSE } from "../agent.ts";
import { negotiate, readerLocale, translator, type Translator } from "../i18n.ts";
import { log } from "../logger.ts";
import { formatNames } from "../plugins/index.ts";
import type { Phase, Progress } from "../progress.ts";
import type { Grade } from "../report/rating.ts";
import { escape, page, reportBody, STYLE } from "../report/html.ts";
import { track } from "./analytics.ts";
import { jobOf, submit, type Jobs } from "./jobs.ts";
import { asset, type Sources } from "./page.ts";
import { presetSettings, presetsOffered, Refusal } from "./policy.ts";
import { latestKey, type ScanJob } from "./queue.ts";
import type { ServerSettings } from "./settings.ts";

declare module "hono" {
    interface ContextVariableMap {
        settings: ServerSettings;
    }
}

// One slot of the owner’s page and what it asks of the policy.
type Fragment = { html: string; sources: Sources };

const BODY_MAX = 64 * 1024;
const ASSET_MAX_AGE_S = 3600;
const REFRESH_S = 5;
const BADGE_MAX_AGE_S = 300;
const LINKS: [name: string, href: string][] = [
    ["dbuho.me", "https://dbuho.me/project/spiderlint/"],
    ["Kiota", "https://kiota.ch/damian-buho/spiderlint"],
    ["GitHub", "https://github.com/damian-buho/spiderlint"],
    ["Codeberg", "https://codeberg.org/damian-buho/spiderlint"],
];
// Resolves from src/ and dist/ alike, since the package ships both.
const LOGO = readFileSync(new URL("../../src/server/logo.png", import.meta.url));
const TOUCH = readFileSync(new URL("../../src/server/apple-touch-icon.png", import.meta.url));
const LOGO_36 = readFileSync(new URL("../../src/server/logo-36.png", import.meta.url));
const LOGO_72 = readFileSync(new URL("../../src/server/logo-72.png", import.meta.url));
const ICONS = '<link rel="icon" type="image/png" sizes="192x192" href="/logo.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">';
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

// The policy of a page: its own stylesheet and script by hash, what the owner’s fragments ask for, same-origin images, events and forms, nothing else; `self` joins scripts and styles only while the owner serves assets.
export function pageCsp(sources?: Sources, hasAssets = false): string {
    const list = (own: string, asked: string[]) => [...new Set([own, ...(hasAssets ? ["'self'"] : []), ...asked])].join(" ");
    return `default-src 'none'; style-src ${list(hash(STYLE), sources?.style ?? [])}; script-src ${list(hash(SCRIPT), sources?.script ?? [])}; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; upgrade-insecure-requests`;
}

// The policy of every page without fragments.
export const PAGE_CSP = pageCsp();

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

// The page in the reader’s language with the owner’s fragments, never cached, under the page policy they extend; the view is reported to Matomo when one is set.
function respond(c: Context, t: Translator, title: string, body: string, status: ContentfulStatusCode = 200, head = ""): Response {
    const { page: owner, matomo } = c.get("settings");
    const slots = (["head", "header", "footer"] as const).map((slot) => owner.fragments?.slot(slot, t.lang) ?? { html: "", sources: { script: [], style: [] } });
    const [fromHead, fromHeader, fromFooter] = slots as [Fragment, Fragment, Fragment];
    const sources = { script: slots.flatMap((slot) => slot.sources.script), style: slots.flatMap((slot) => slot.sources.style) };
    const privacy = matomo ? `<a href="${escape(matomo.privacy)}" rel="noopener noreferrer">${escape(t._("Privacy"))}</a>` : "";
    const origin = new URL(c.req.url).origin;
    const self = new URL(c.req.path, origin).href;
    const description = t._("Check every page of a site: SEO tags, security headers, TLS, links and more.");
    const seo = `<meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(self)}"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:image" content="${escape(`${origin}/logo.png`)}"><meta property="og:url" content="${escape(self)}"><meta property="og:type" content="website">`;
    const skip = `<a class="skip" href="#main">${escape(t._("Skip to main content"))}</a>`;
    const nav = `<header class="site"><a class="brand" href="/"><img src="/logo.png" srcset="/logo-36.png 36w, /logo-72.png 72w" sizes="36px" alt="" width="36" height="36">spiderlint</a><nav><a href="/">${escape(t._("New scan"))}</a><a href="${LINKS[0]?.[1]}" rel="noopener noreferrer">${escape(t._("Self-host"))}</a></nav></header>`;
    const links = LINKS.map(([name, href]) => `<a href="${escape(href)}" rel="noopener noreferrer">${escape(name)}</a>`).join("");
    const foot = `<footer class="foot"><p>${escape(t._("Self-host spiderlint: free software under the {license} licence.", { license: LICENSE }))}</p>${links}${privacy}</footer>`;
    c.header("content-security-policy", pageCsp(sources, owner.assets !== undefined));
    c.header("cache-control", "no-cache");
    c.header("vary", "accept-language");
    track(matomo, c, routePath(c), URL.canParse(title) ? new URL(title).hostname : undefined);
    return c.html(page(t, title, `${skip}${fromHeader.html}${nav}${body}${foot}${fromFooter.html}`, ICONS + seo + head + fromHead.html), status);
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
    const options = offered.map((name) => `<label for="preset-${escape(name)}"><input id="preset-${escape(name)}" type="radio" name="preset" value="${escape(name)}"${name === checked ? " checked" : ""}> ${escape(text[name]?.[0] ?? name)} <small class="muted">${escape(text[name]?.[1] ?? "")}</small></label>`);
    return `<fieldset><legend class="muted">${escape(t._("Checks"))}</legend>${options.join("")}</fieldset>`;
}

// The form, with the address typed, the preset chosen and the refusal it met, if any.
function formPage(c: Context, t: Translator, offered: string[], typed = "", refusal?: Refusal, chosen?: string): Response {
    if (refusal?.retryAfter !== undefined) c.header("retry-after", String(refusal.retryAfter));
    const alert = refusal ? `<p class="alert" role="alert">${escape(refusalText(t, refusal))}${refusal.code === "banned" ? `<br><small>${escape(refusal.message)}</small>` : ""}</p>` : "";
    const body = `<main id="main"><h1>spiderlint</h1><p>${escape(t._("Checks every page of a site: search engine tags, security headers, TLS, links and more."))}</p>${alert}<form method="post" action="/"><label for="url" class="muted">${escape(t._("Site address"))}</label><input id="url" name="url" type="text" inputmode="url" autocomplete="url" required spellcheck="false" placeholder="example.com" value="${escape(typed)}"${refusal ? ' aria-invalid="true"' : ""}><button type="submit">${escape(t._("Scan"))}</button>${presetChoice(t, offered, chosen)}</form><p class="muted"><small>${escape(t._("Scans obey robots.txt and identify themselves as spiderlint. A finished report is public: its link and the site’s badge lead to it."))}</small></p></main>`;
    return respond(c, t, t._("spiderlint — scan every page of a website"), body, refusal?.status ?? 200);
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
    const attributes = [
        ["events", `/v1/jobs/${job.id}/events`],
        ["locale", t.locale],
        ["running", t._("Scanning…")],
        ["count", count],
        ["eta", t._("About {range} left", { range: "{range}" })],
        ["under", t._("Less than {range} left", { range: "{range}" })],
        ["step", stepText],
        ["phases", JSON.stringify(names)],
    ]
        .map(([name, value]) => `data-${name}="${escape(value as string)}"`)
        .join(" ");
    const rulesets = (job.data.settings?.rules as string[] | undefined)?.join(", ");
    return `<div ${attributes}><p data-state>${escape(state)}</p>${rulesets ? `<p class="muted">${escape(t._("Rulesets: {names}", { names: rulesets }))}</p>` : ""}<progress${values}></progress><p><span data-count>${total === undefined ? "" : escape(t._("Pages: {done} of {total}", { done: t.number(done ?? 0), total: t.number(total) }))}</span> <span data-eta class="muted">${escape(etaLine(t, eta))}</span></p><p data-phase class="muted">${escape(phaseText)}</p></div>`;
}

// When a fresh scan of the site may start, and the way to it; `isRepeat` adds why the reader sees an earlier scan.
function scanNote(t: Translator, job: ScanJob, wait: number, isRepeat: boolean): string {
    const lead = isRepeat ? `${t._("This site was scanned recently, so this is the existing report.")} ` : "";
    const next = wait > 0 ? t._("A new scan of this site can start {when}.", { when: relative(t, wait) }) : t._("You can scan this site again now.");
    const action = wait > 0 ? "" : `<a class="button" href="/?url=${encodeURIComponent(job.data.host)}">${escape(t._("Scan again"))}</a>`;
    return `<div class="notice" role="status"><p>${escape(lead + next)}</p>${action}</div>`;
}

// The report with its scan note, downloads and badge.
function doneBody(t: Translator, job: ScanJob, wait: number, isRepeat: boolean): string {
    const downloads = formatNames()
        .map((name) => `<a href="/v1/jobs/${escape(job.id)}/report/${escape(name)}">${escape(name)}</a>`)
        .join(" · ");
    const badge = `/badge/${escape(job.data.host)}.svg`;
    return `${scanNote(t, job, wait, isRepeat)}${reportBody(job.returnvalue, t, shown(job.data.url), new URL(job.data.url).origin)}<h2>${escape(t._("Downloads"))}</h2><p>${downloads}</p><h2>${escape(t._("Badge"))}</h2><p><a href="${badge}"><img src="${badge}" alt="${escape(t._("Rating badge"))}"></a></p>`;
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

// `bytes` as an image answer with a shared cache lifetime.
function image(bytes: Buffer, type = "image/png"): (c: Context) => Response {
    return (c: Context) => {
        c.header("content-type", type);
        c.header("cache-control", `public, max-age=${ASSET_MAX_AGE_S}`);
        return c.body(new Uint8Array(bytes));
    };
}

// The form, the job pages and the badge, rendered on the server and complete without scripts.
export function web(jobs: Jobs): Hono {
    const app = new Hono();

    // The settings as they are for this request, for the pages’ fragments and Matomo.
    app.use(async (c, next) => {
        c.set("settings", jobs.settings());
        await next();
    });

    // The owner’s files, served as they are from one directory: never a listing, a dotfile or a path out of it.
    app.get("/assets/*", async (c) => {
        const { assets } = jobs.settings().page;
        let relative = "";
        try {
            relative = decodeURIComponent(c.req.path.slice("/assets/".length));
        } catch {
            log.debug({ path: c.req.path }, "asset path not decodable");
        }
        const file = assets && relative ? await asset(assets, relative) : undefined;
        log.debug({ path: c.req.path, isServed: file !== undefined }, "asset requested");
        if (!file) throw new Refusal(404, "not-found", `${c.req.path}: no such asset`);
        c.header("content-type", file.type);
        c.header("content-security-policy", "default-src 'none'; sandbox");
        c.header("cache-control", `public, max-age=${ASSET_MAX_AGE_S}`);
        return c.body(new Uint8Array(file.body));
    });

    const offered = () => presetsOffered(jobs.settings());

    // Text answers leave compressed when the client asks for gzip.
    app.use(compress());

    app.get("/logo.png", (c) => {
        log.debug({ bytes: LOGO.length }, "logo served");
        return image(LOGO)(c);
    });

    app.get("/favicon.ico", (c) => {
        log.debug({ bytes: LOGO.length }, "favicon served");
        return image(LOGO)(c);
    });

    app.get("/apple-touch-icon.png", (c) => {
        log.debug({ bytes: TOUCH.length }, "apple touch icon served");
        return image(TOUCH)(c);
    });

    app.get("/logo-36.png", (c) => image(LOGO_36)(c));

    app.get("/logo-72.png", (c) => image(LOGO_72)(c));

    // RFC 9116 contact point with a rolling half-year expiry, so the date never goes stale.
    app.get("/.well-known/security.txt", (c) => {
        const expires = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d+Z$/, "Z");
        log.debug({ expires }, "security.txt served");
        c.header("content-type", "text/plain; charset=utf-8");
        c.header("cache-control", "public, max-age=86400");
        return c.body(`Contact: mailto:damian.buho@proton.me\nExpires: ${expires}\nPreferred-Languages: en\n`);
    });

    app.get("/", (c) => formPage(c, translate(c), offered(), c.req.query("url") ?? ""));

    app.post("/", bodyLimit({ maxSize: BODY_MAX, onError: (c) => formPage(c, translate(c), offered(), "", new Refusal(400, "invalid-body", "form too large")) }), async (c) => {
        const t = translate(c);
        const form = await formOf(c);
        const typed = typeof form.url === "string" ? form.url : "";
        const preset = typeof form.preset === "string" ? form.preset : undefined;
        try {
            if (c.req.header("sec-fetch-site") === "cross-site") throw new Refusal(403, "cross-site", "form sent from another site");
            const { job, isRepeat } = await submit(jobs, { url: seedOf(typed), ...(preset !== undefined && { settings: presetSettings(preset) }) }, c);
            log.debug({ job: job.id, isRepeat, preset }, "form submitted");
            return c.redirect(isRepeat ? `/jobs/${job.id}?repeat` : `/jobs/${job.id}`, 303);
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
            return respond(c, t, t._("Scan not found"), `<main id="main"><h1>${escape(t._("Scan not found"))}</h1><p>${escape(refusalText(t, error))}</p><p><a href="/">${escape(t._("Start a new scan"))}</a></p></main>`, 404);
        }
        const state = await job.getState();
        const title = shown(job.data.url);
        const isRepeat = c.req.query("repeat") !== undefined;
        const wait = job.data.repeatKey ? await jobs.redis.ttl(job.data.repeatKey) : 0;
        log.debug({ job: job.id, state, isRepeat, wait }, "job page rendered");
        if (state === "completed") return respond(c, t, title, `<main id="main">${doneBody(t, job, wait, isRepeat)}</main>`);
        if (state === "failed") return respond(c, t, title, `<main id="main"><h1>${escape(title)}</h1><p class="alert" role="alert">${escape(t._("The scan failed."))}</p><p><code>${escape(job.failedReason)}</code></p><p><a href="/">${escape(t._("Start a new scan"))}</a></p></main>`);
        const body = `<main id="main"><h1>${escape(title)}</h1>${isRepeat ? `<p class="notice">${escape(t._("This site was scanned recently, so this is the existing scan."))}</p>` : ""}${progressBody(t, job, state === "active" ? "running" : "queued")}</main><script>${SCRIPT}</script>`;
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
