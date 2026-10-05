// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { BlockList } from "node:net";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { ConfigError } from "../src/config/index.ts";
import { negotiate, readerLocale, translator } from "../src/i18n.ts";
import { api } from "../src/server/api.ts";
import { Buckets, clientOf } from "../src/server/clients.ts";
import { admit, policyFor, presetSettings, presetsOffered, Refusal, resolveRules } from "../src/server/policy.ts";
import { addRanges } from "../src/server/providers.ts";
import { connect, scanQueue } from "../src/server/queue.ts";
import { hostSuffix, settingsOf } from "../src/server/settings.ts";
import { startWorker } from "../src/server/worker.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";

const SETTINGS = settingsOf({
    policies: [
        { name: "ru", hosts: ["ru", "рф"], ban: true },
        { name: "ua", hosts: [".ua"], rate: { jobs: 1, per: "1h" }, caps: { "max-pages": 20, concurrency: 2 }, rules: { allow: ["seo", "http/*"], deny: ["http/alt-svc-h3"] } },
        { name: "rest", hosts: ["*"] },
    ],
});

// The Refusal code `run` throws.
function refusal(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof Refusal) return error.code;
        throw error;
    }
    return "admitted";
}

describe("server settings", () => {
    it("reads a host suffix in any spelling as punycode", () => {
        assert.equal(hostSuffix("*.UA"), "ua");
        assert.equal(hostSuffix(".ua."), "ua");
        assert.equal(hostSuffix("рф"), "xn--p1ai");
        assert.equal(hostSuffix("*"), "*");
    });

    it("defaults to one policy admitting every host, http only, 100 pages", () => {
        const [policy] = settingsOf({}).policies;
        assert.deepEqual([policy?.hosts, policy?.fetch, policy?.caps["max-pages"], policy?.scanTimeout], [["*"], ["http"], 100, 600]);
    });

    it("refuses the browser while private addresses are refused", () => {
        assert.throws(() => settingsOf({ policies: [{ name: "b", hosts: ["*"], fetch: ["browser"] }] }), ConfigError);
        assert.doesNotThrow(() => settingsOf({ "allow-private": true, policies: [{ name: "b", hosts: ["*"], fetch: ["browser"] }] }));
    });

    it("names an unknown key and a bad default", () => {
        assert.throws(() => settingsOf({ polices: [] }), /unknown key "polices"/);
        assert.throws(() => settingsOf({ defaults: { "max-pages": "lots" } }), /server\/defaults\/max-pages/);
    });
});

describe("server clients", () => {
    const trusted = [settingsOf({ clients: { "trusted-proxies": ["172.18.0.0/16", "::1"] } }).clients.trusted];

    it("believes X-Forwarded-For only from a trusted proxy, right to left", () => {
        assert.equal(clientOf("203.0.113.9", "198.51.100.1", trusted), "203.0.113.9");
        assert.equal(clientOf("::ffff:172.18.0.2", "10.9.9.9, 198.51.100.1", trusted), "198.51.100.1");
        assert.equal(clientOf("::1", "198.51.100.1, 172.18.0.5", trusted), "198.51.100.1");
        assert.equal(clientOf("172.18.0.2", "nonsense", trusted), "172.18.0.2");
    });

    it("walks past a trusted CDN edge to the client behind it", () => {
        const edges = new BlockList();
        assert.equal(addRanges(edges, "173.245.48.0/20\n2400:cb00::/32\nnot-a-range\n10.0.0.0/99\n"), 2);
        assert.equal(clientOf("172.18.0.2", "198.51.100.7, 173.245.48.5", [...trusted, edges]), "198.51.100.7");
        assert.equal(clientOf("172.18.0.2", "198.51.100.7, 173.245.48.5", trusted), "173.245.48.5");
        assert.equal(addRanges(new BlockList(), '{"addresses":["23.235.32.0/20"],"ipv6_addresses":["2a04:4e40::/32"]}'), 2);
    });

    it("refills a bucket evenly and names the wait when it is empty", () => {
        const buckets = new Buckets();
        const rate = { jobs: 2, seconds: 60 };
        assert.deepEqual([buckets.take("a", rate, 0), buckets.take("a", rate, 0), buckets.take("a", rate, 0)], [0, 0, 30]);
        assert.equal(buckets.take("b", rate, 0), 0);
        assert.equal(buckets.take("a", rate, 30_000), 0);
    });

    it("defaults to ten jobs an hour, `false` turns it off, a bad network is refused", () => {
        assert.deepEqual(settingsOf({}).clients.rate, { jobs: 10, seconds: 3600 });
        assert.equal(settingsOf({ clients: { rate: false } }).clients.rate, undefined);
        assert.throws(() => settingsOf({ clients: { "trusted-proxies": ["10.0.0.0/x"] } }), ConfigError);
        assert.throws(() => settingsOf({ clients: { "trust-providers": ["bogus"] } }), ConfigError);
        assert.deepEqual(settingsOf({ clients: { "trust-providers": ["cloudflare"] } }).clients.providers, ["cloudflare"]);
    });
});

describe("server language", () => {
    it("picks the best supported language by q-value, English otherwise", () => {
        assert.equal(negotiate("uk-UA,uk;q=0.9,en;q=0.8"), "uk");
        assert.equal(negotiate("fr, es;q=0.5"), "es");
        assert.equal(negotiate("de"), "en");
        assert.equal(negotiate("es;q=0, uk;q=0.1"), "uk");
        assert.equal(negotiate("uk_UA.UTF-8"), "uk");
        assert.equal(negotiate(undefined), "en");
    });

    it("writes numbers in the reader’s first locale, with or without a catalog", () => {
        assert.equal(readerLocale("de-DE,de;q=0.9,en;q=0.8"), "de-DE");
        assert.equal(readerLocale("fr;q=0.2, es-CL;q=0.9"), "es-CL");
        assert.equal(readerLocale("de_DE.UTF-8"), "de-DE");
        assert.equal(readerLocale("C"), undefined);
        assert.equal(readerLocale("*"), undefined);
        const t = translator(negotiate("de-DE"), readerLocale("de-DE"));
        assert.equal(t.lang, "en");
        assert.equal(t.number(31_536_000), "31.536.000");
        assert.equal(translator("es").number(31_536_000), "31.536.000");
        assert.equal(translator("en").number(31_536_000), "31,536,000");
    });
});

describe("server pages without Redis", () => {
    const app = api({} as Queue, {} as Redis, () => SETTINGS);

    it("serves the form in the reader’s language under a strict policy", async () => {
        const response = await app.request("/", { headers: { "accept-language": "es-CL,es;q=0.9" } });
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.match(html, /<html lang="es" dir="ltr">/);
        assert.ok(html.includes("Dirección del sitio"));
        assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'; style-src 'sha256-/);
    });

    it("shows a refusal on the form, translated, keeping what was typed", async () => {
        const response = await app.request("/", { method: "POST", headers: { "accept-language": "uk", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: "https://кремль.рф/" }).toString() });
        const html = await response.text();
        assert.equal(response.status, 403);
        assert.ok(html.includes("Перевірки цього сайту вимкнено"));
        assert.ok(html.includes('value="https://кремль.рф/"'));
    });

    it("renders a finished report in English with the numbers of a de-DE reader, labelled statistics only", async () => {
        const stat = { count: 2, min: 1, median: 2, p95: 3, max: 3, total: 31_536_000 };
        const summary = {
            started: "2026-10-03T00:00:00Z",
            durationMs: 1000,
            pages: 2,
            bytes: 10,
            groups: { default: 2 },
            statuses: {},
            findings: { total: 0, error: 0, warning: 0, info: 0, hint: 0 },
            rules: 0,
            checks: { total: 0, passed: 0, failed: 0, errored: 0 },
            byRule: {},
            cost: {},
            stats: { "resources.length": stat, "html.text": stat },
        };
        const job = { id: "j1", data: { url: "https://a.test/", host: "a.test" }, returnvalue: { summary, findings: [] }, getState: async () => "completed" };
        const response = await api({ getJob: async () => job } as unknown as Queue, {} as Redis, () => SETTINGS).request("/jobs/j1", { headers: { "accept-language": "de-DE,de;q=0.9" } });
        const html = await response.text();
        assert.match(html, /<html lang="en" dir="ltr">/);
        assert.ok(html.includes("31.536.000"), "German digits");
        assert.ok(html.includes("<h2>Statistics</h2>") && html.includes("Resources"), "English strings");
        assert.ok(!html.includes("html.text"), "unlabelled fact left to json");
    });

    it("names the phase after the last page with its count and a time left without a fraction", async () => {
        const progress = { done: 100, total: 100, phase: "resources", step: { done: 40, total: 230 }, eta: { low: 0, high: 2, unit: "minute" } };
        const job = { id: "j2", data: { url: "https://a.test/", host: "a.test" }, progress, getState: async () => "active" };
        const response = await api({ getJob: async () => job } as unknown as Queue, {} as Redis, () => SETTINGS).request("/jobs/j2", { headers: { "accept-language": "es" } });
        const html = await response.text();
        assert.ok(html.includes("Comprobando los recursos enlazados: 40 de 230"), html);
        assert.ok(html.includes("Quedan menos de 2 min"), html);
        const script = /<script>([^]*)<\/script>/.exec(html)?.[1] ?? "";
        assert.doesNotThrow(() => new Function(script), "inline script parses");
        assert.ok(response.headers.get("content-security-policy")?.includes("script-src 'sha256-"));
    });

    it("offers the web presets as radios, the default first and checked, in the reader’s language", async () => {
        const response = await app.request("/", { headers: { "accept-language": "es" } });
        const html = await response.text();
        assert.match(html, /<input type="radio" name="preset" value="recommended" checked> Estándar/);
        assert.ok(html.indexOf('value="web-quick"') > html.indexOf('value="recommended"') && html.indexOf('value="web-comprehensive"') > html.indexOf('value="web-quick"'));
        assert.equal(html.match(/ checked>/g)?.length, 1);
    });

    it("refuses a preset the host’s policy does not allow, keeping the choice on the form", async () => {
        const response = await app.request("/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: "a.ua", preset: "web-comprehensive" }).toString() });
        const html = await response.text();
        assert.equal(response.status, 403);
        assert.ok(html.includes("A requested rule is not available on this instance."));
        assert.match(html, /value="web-comprehensive" checked/);
        const unknown = await app.request("/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: "example.com", preset: "all" }).toString() });
        assert.equal(unknown.status, 400);
    });

    it("shows the rulesets a running scan was queued with", async () => {
        const job = { id: "j3", data: { url: "https://a.test/", host: "a.test", settings: { rules: ["web-quick"] } }, progress: { done: 1, total: 2, phase: "crawl" }, getState: async () => "active" };
        const response = await api({ getJob: async () => job } as unknown as Queue, {} as Redis, () => SETTINGS).request("/jobs/j3");
        const html = await response.text();
        assert.ok(html.includes("Rulesets: web-quick"));
    });

    it("refuses a form sent from another site", async () => {
        const response = await app.request("/", { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" }, body: "url=example.com" });
        assert.equal(response.status, 403);
    });

    it("draws an unscanned badge any site may embed", async () => {
        const response = await api({} as Queue, { get: async () => "" } as unknown as Redis, () => SETTINGS).request("/badge/example.com.svg");
        assert.equal(response.headers.get("content-type"), "image/svg+xml; charset=utf-8");
        assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
        assert.match(await response.text(), /not scanned/);
    });
});

describe("web presets", () => {
    it("offers those some policy admits, none when every policy bans", () => {
        assert.deepEqual(presetsOffered(SETTINGS), ["recommended", "web-quick", "web-comprehensive"]);
        const narrow = settingsOf({ policies: [{ name: "a", hosts: ["*"], rules: { allow: ["web-quick", "seo"] } }] });
        assert.deepEqual(presetsOffered(narrow), ["web-quick"]);
        assert.deepEqual(presetsOffered(settingsOf({ policies: [{ name: "b", hosts: ["*"], ban: true }] })), []);
    });

    it("lowers caps and never raises them past the policy", () => {
        const quick = admit({ url: "https://example.com/", settings: presetSettings("web-quick") }, SETTINGS).settings;
        assert.deepEqual([quick["max-pages"], quick.rules, quick.resources], [25, ["web-quick"], { fetch: false }]);
        const capped = settingsOf({ policies: [{ name: "a", hosts: ["*"], caps: { "max-pages": 10 } }] });
        assert.equal(admit({ url: "https://example.com/", settings: presetSettings("web-quick") }, capped).settings["max-pages"], 10);
        assert.equal(admit({ url: "https://example.com/", settings: presetSettings("web-comprehensive") }, SETTINGS).settings["max-pages"], 100);
    });

    it("answers a policy that does not allow the preset with forbidden-rule, and an unknown one with unknown-rule", () => {
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/", settings: presetSettings("web-quick") }, SETTINGS)),
            "forbidden-rule",
        );
        assert.equal(
            refusal(() => presetSettings("all")),
            "unknown-rule",
        );
    });
});

// The CSP hash source of `text`.
const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
// The owner’s inline head script for `lang`.
const headScript = (lang: string) => `window.owner = "${lang}";`;
// The body and one header of a response, awaited so a test reads them without chaining.
async function read(response: Response | Promise<Response>, header?: string): Promise<{ status: number; text: string; header: string }> {
    const settled = await response;
    return { status: settled.status, text: await settled.text(), header: header ? (settled.headers.get(header) ?? "") : "" };
}

describe("server page customisation", () => {
    let directory: string;
    let app: ReturnType<typeof api>;
    const page = (accept: string) => read(app.request("/", { headers: { "accept-language": accept } }), "content-security-policy");

    before(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-page-"));
        await mkdir(path.join(directory, "page"));
        await mkdir(path.join(directory, "assets", "sub"), { recursive: true });
        await writeFile(path.join(directory, "page", "head.html"), `<script>${headScript("{lang}")}</script><link rel="stylesheet" href="https://cdn.test/x.css" integrity="sha384-abc" crossorigin="anonymous">`);
        await writeFile(path.join(directory, "page", "footer.html"), '<p id="owner">Footer {dir}</p>');
        await writeFile(path.join(directory, "page", "footer.uk.html"), '<p id="owner">Підвал {lang}</p>');
        await writeFile(path.join(directory, "assets", "app.js"), "export const x = 1;\n");
        await writeFile(path.join(directory, "assets", ".secret"), "no");
        await writeFile(path.join(directory, "secret.txt"), "outside");
        const settings = settingsOf({ page: { directory: path.join(directory, "page"), assets: path.join(directory, "assets") } });
        app = api({} as Queue, {} as Redis, () => settings);
    });

    after(() => rm(directory, { recursive: true, force: true }));

    it("renders a fragment per language, falling back to the plain file, with {lang} and {dir} filled", async () => {
        const uk = await page("uk");
        assert.ok(uk.text.includes('<p id="owner">Підвал uk</p>') && !uk.text.includes("Footer"));
        const es = await page("es");
        assert.ok(es.text.includes('<p id="owner">Footer ltr</p>'));
        assert.ok(es.text.includes(`<script>${headScript("es")}</script>`), "head sits in the document");
    });

    it("allows an inline script by its hash, an external stylesheet by its origin and self for assets, in that response only", async () => {
        const { header: csp } = await page("uk");
        const [own, other] = [sha(headScript("uk")), sha(headScript("es"))];
        assert.ok(csp.includes(own), csp);
        assert.ok(!csp.includes(other), "another language’s hash is not allowed");
        assert.match(csp, /style-src [^;]*https:\/\/cdn\.test/);
        assert.match(csp, /script-src [^;]*'self'/);
    });

    it("refuses an external script without integrity at load, naming the file", async () => {
        const bad = path.join(directory, "bad");
        await mkdir(bad);
        await writeFile(path.join(bad, "head.html"), '<script src="https://cdn.test/a.js"></script>');
        assert.throws(() => settingsOf({ page: { directory: bad } }), /head\.html.*needs an integrity attribute/);
        await writeFile(path.join(bad, "head.html"), '<script src="https://cdn.test/a.js" integrity="sha384-abc"></script>');
        const settings = settingsOf({ page: { directory: bad } });
        const { header: csp } = await read(api({} as Queue, {} as Redis, () => settings).request("/"), "content-security-policy");
        assert.match(csp, /script-src [^;]*https:\/\/cdn\.test/);
        await writeFile(path.join(bad, "head.html"), '<script src="ftp://cdn.test/a.js" integrity="sha384-abc"></script>');
        assert.throws(() => settingsOf({ page: { directory: bad } }), /must be an https URL/);
    });

    it("serves assets with their type and never a listing, a dotfile or a path out of the directory", async () => {
        const served = await app.request("/assets/app.js");
        assert.equal(served.status, 200);
        assert.match(served.headers.get("content-type") ?? "", /^text\/javascript/);
        assert.equal(served.headers.get("x-content-type-options"), "nosniff");
        assert.equal(await served.text(), "export const x = 1;\n");
        for (const url of ["/assets/", "/assets/sub", "/assets/sub/", "/assets/.secret", "/assets/..%2fsecret.txt", "/assets/%2e%2e/secret.txt", "/assets/missing.js"]) {
            const { status } = await read(app.request(url));
            assert.equal(status, 404, url);
        }
    });

    it("leaves the badge alone and serves no assets when none are set", async () => {
        const badge = await read(api({} as Queue, { get: async () => "" } as unknown as Redis, () => settingsOf({ page: { directory: path.join(directory, "page") } })).request("/badge/example.com.svg"), "content-security-policy");
        assert.equal(badge.header, "default-src 'none'");
        assert.ok(!badge.text.includes("Footer"));
        const bare = api({} as Queue, {} as Redis, () => SETTINGS);
        const missing = await read(bare.request("/assets/app.js"));
        assert.equal(missing.status, 404);
        const form = await read(bare.request("/"));
        assert.ok(!form.text.includes('id="owner"'));
    });

    it("reports page views to Matomo without a script, never the badge, DNT, Sec-GPC or the API, and links the privacy statement", async () => {
        const calls: URL[] = [];
        const stub = mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
            calls.push(new URL(String(input)));
            return new Response(undefined, { status: 204 });
        });
        try {
            const settings = settingsOf({ analytics: { matomo: { url: "https://mtm.test/", "site-id": 3, site: "https://scan.test/", privacy: "https://scan.test/privacy" } } });
            const tracked = api({ getJob: async () => ({ id: "j9", data: { url: "https://secret-host.test/", host: "secret-host.test", settings: {} }, progress: {}, getState: async () => "active" }) } as unknown as Queue, {} as Redis, () => settings);
            const form = await tracked.request("/", { headers: { "user-agent": "Test/1", "accept-language": "uk" } });
            const privacy = await form.text();
            assert.ok(privacy.includes('href="https://scan.test/privacy"'));
            assert.equal(calls.length, 1);
            const [call] = calls;
            assert.deepEqual([call?.origin, call?.pathname, call?.searchParams.get("idsite"), call?.searchParams.get("url"), call?.searchParams.get("action_name"), call?.searchParams.get("ua")], ["https://mtm.test", "/matomo.php", "3", "https://scan.test/", "Scan form", "Test/1"]);
            await tracked.request("/jobs/j9");
            assert.equal(calls.at(-1)?.searchParams.get("action_name"), "Scan report");
            assert.ok(!calls.at(-1)?.href.includes("secret-host"), "no scanned host in what is tracked");
            const before = calls.length;
            await tracked.request("/", { headers: { dnt: "1" } });
            await tracked.request("/", { headers: { "sec-gpc": "1" } });
            await tracked.request("/badge/example.com.svg");
            await tracked.request("/v1/jobs/j9");
            await tracked.request("/assets/app.js");
            assert.equal(calls.length, before);
            const named = settingsOf({ analytics: { matomo: { url: "https://mtm.test/", "site-id": 3, site: "https://scan.test/", privacy: "https://scan.test/privacy", "include-hosts": true } } });
            await api({ getJob: async () => ({ id: "j9", data: { url: "https://secret-host.test/", host: "secret-host.test", settings: {} }, progress: {}, getState: async () => "active" }) } as unknown as Queue, {} as Redis, () => named).request("/jobs/j9");
            assert.equal(calls.at(-1)?.searchParams.get("action_name"), "Scan report: secret-host.test");
        } finally {
            stub.mock.restore();
        }
    });

    it("pauses tracking after Matomo fails, and the page still renders", async () => {
        const stub = mock.method(globalThis, "fetch", async () => {
            throw new Error("down");
        });
        try {
            const settings = settingsOf({ analytics: { matomo: { url: "https://mtm.test/", "site-id": 3, site: "https://scan.test/", privacy: "https://scan.test/privacy" } } });
            const tracked = api({} as Queue, {} as Redis, () => settings);
            const first = await read(tracked.request("/"));
            await sleep(20);
            const second = await read(tracked.request("/"));
            assert.deepEqual([first.status, second.status], [200, 200]);
            assert.equal(stub.mock.callCount(), 1, "one failure pauses further reports");
        } finally {
            stub.mock.restore();
        }
    });
});

describe("server policy", () => {
    it("matches the first policy whose suffix ends the host", () => {
        assert.equal(policyFor("xn--80ak6aa92e.xn--p1ai", SETTINGS.policies)?.name, "ru");
        assert.equal(policyFor("kyiv.gov.ua", SETTINGS.policies)?.name, "ua");
        assert.equal(policyFor("mua", SETTINGS.policies)?.name, "rest");
    });

    it("refuses bans, bad seeds and settings a request may not set", () => {
        assert.equal(
            refusal(() => admit({ url: "https://кремль.рф/" }, SETTINGS)),
            "banned",
        );
        assert.equal(
            refusal(() => admit({ url: "file:///etc/passwd" }, SETTINGS)),
            "invalid-url",
        );
        assert.equal(
            refusal(() => admit({ url: "https://user:pass@example.com/" }, SETTINGS)),
            "invalid-url",
        );
        assert.equal(
            refusal(() => admit({ url: "https://example.com/", settings: { plugins: ["./x.ts"] } }, SETTINGS)),
            "forbidden-setting",
        );
        assert.equal(
            refusal(() => admit({ url: "https://example.com/", settings: { robots: false } }, SETTINGS)),
            "forbidden-setting",
        );
        assert.equal(
            refusal(() => admit({ url: "https://example.com/", settings: { "max-pages": -1 } }, SETTINGS)),
            "invalid-settings",
        );
        assert.equal(
            refusal(() => admit({ url: "https://example.com/", settings: { fetch: "browser" } }, SETTINGS)),
            "forbidden-fetch",
        );
    });

    it("allows named rules only, and treats no rules as recommended", () => {
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["seo", "http/hsts"] } }, SETTINGS)),
            "admitted",
        );
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["http/alt-svc-h3"] } }, SETTINGS)),
            "forbidden-rule",
        );
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/", settings: { rules: ["all"] } }, SETTINGS)),
            "forbidden-rule",
        );
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/" }, SETTINGS)),
            "forbidden-rule",
        );
        assert.equal(
            refusal(() => admit({ url: "https://a.ua/", settings: { groups: { blog: { match: ["/blog/**"], rules: ["seo"] } } } }, SETTINGS)),
            "forbidden-rule",
        );
    });

    it("refuses an unknown rule before any window is charged, and resolves a known one", async () => {
        await assert.rejects(resolveRules(admit({ url: "https://a.ua/", settings: { rules: ["http/nope"] } }, SETTINGS)), (error: Refusal) => error.code === "unknown-rule");
        await assert.doesNotReject(resolveRules(admit({ url: "https://a.ua/", settings: { rules: ["seo"] } }, SETTINGS)));
    });

    it("reads a repeat window per policy", () => {
        assert.equal(settingsOf({ policies: [{ name: "r", hosts: ["*"], repeat: "30m" }] }).policies[0]?.repeat, 1800);
    });

    it("clamps to the caps, where 0 or unset is unlimited, and pins the guard", () => {
        const { settings } = admit({ url: "https://a.ua/", settings: { rules: ["seo"], "max-pages": 0, concurrency: 1 } }, SETTINGS);
        assert.deepEqual([settings["max-pages"], settings.concurrency, settings.fetch, settings.robots, settings["allow-private"]], [20, 1, "http", true, false]);
        assert.equal(admit({ url: "https://a.ua/", settings: { rules: ["seo"], "max-pages": 500 } }, SETTINGS).settings["max-pages"], 20);
    });
});

describe("server over Redis", { skip: process.env.SPIDERLINT_TEST_REDIS === undefined && "SPIDERLINT_TEST_REDIS unset" }, () => {
    let site: Fixture;
    const [redis, workerRedis] = [connect(process.env.SPIDERLINT_TEST_REDIS ?? ""), connect(process.env.SPIDERLINT_TEST_REDIS ?? "")];
    const queue = scanQueue(redis, 60);
    const worker = startWorker(workerRedis, 1, 60);
    let settings = settingsOf({ "allow-private": true, policies: [{ name: "fixture", hosts: ["127.0.0.1"], rate: { jobs: 1, per: 60 }, caps: { "max-pages": 3 } }] });
    const app = api(queue, redis, () => settings);
    let first = "";
    const post = async () => app.request("/v1/jobs", { method: "POST", body: JSON.stringify({ url: `${site.origin}/?client=${Date.now()}` }) });

    before(async () => {
        site = await serveFixture();
        await redis.del(`spiderlint:rate:fixture:127.0.0.1`, "spiderlint:latest:127.0.0.1");
    });

    after(async () => {
        await worker.close();
        await queue.close();
        await redis.quit();
        await workerRedis.quit();
        await site.close();
    });

    it("queues a scan, reports its progress, then every format", async () => {
        const created = await app.request("/v1/jobs", { method: "POST", body: JSON.stringify({ url: `${site.origin}/`, settings: { rules: ["seo"] } }) });
        assert.equal(created.status, 202);
        const { id } = (await created.json()) as { id: string };
        first = id;
        let job: { status: string; progress?: { done: number }; summary?: { pages: number } } = { status: "queued" };
        for (let tries = 0; tries < 120 && !["done", "failed"].includes(job.status); tries += 1) {
            await sleep(500);
            const response = await app.request(`/v1/jobs/${id}`);
            job = (await response.json()) as typeof job;
        }
        assert.equal(job.status, "done");
        assert.equal(job.summary?.pages, 3);
        assert.equal(job.progress?.done, 3);
        const sarif = await app.request(`/v1/jobs/${id}/report/sarif`);
        assert.equal(sarif.headers.get("content-type"), "application/sarif+json; charset=utf-8");
        const document = (await sarif.json()) as { version: string };
        assert.equal(document.version, "2.1.0");
        const pdf = await app.request(`/v1/jobs/${id}/report/pdf`);
        assert.equal(pdf.status, 404);
    });

    it("refuses a second scan inside the host’s window", async () => {
        const again = await app.request("/v1/jobs", { method: "POST", body: JSON.stringify({ url: `${site.origin}/` }) });
        assert.equal(again.status, 429);
        assert.ok(Number(again.headers.get("retry-after")) > 0);
    });

    it("renders the finished report page and the host’s badge linking to it", async () => {
        const page = await app.request(`/jobs/${first}`, { headers: { "accept-language": "uk" } });
        const html = await page.text();
        assert.equal(page.status, 200);
        assert.ok(html.includes("Завантаження"));
        assert.ok(html.includes(`/v1/jobs/${first}/report/html`));
        let svg = "";
        for (let tries = 0; tries < 20 && !svg.includes(first); tries += 1) {
            const response = await app.request("/badge/127.0.0.1.svg");
            svg = await response.text();
            await sleep(100);
        }
        assert.ok(svg.includes(`href="/jobs/${first}"`));
        assert.match(svg, /<text[^>]*>[SA-F]<\/text>/);
    });

    it("returns the same job for a repeat inside the policy’s window", async () => {
        settings = settingsOf({ "allow-private": true, policies: [{ name: "repeat", hosts: ["127.0.0.1"], repeat: "1h", caps: { "max-pages": 1 } }] });
        const body = JSON.stringify({ url: `${site.origin}/?repeat=${Date.now()}`, settings: { rules: ["seo"] } });
        const one = await app.request("/v1/jobs", { method: "POST", body });
        const two = await app.request("/v1/jobs", { method: "POST", body });
        assert.deepEqual([one.status, two.status], [202, 200]);
        assert.equal(((await one.json()) as { id: string }).id, ((await two.json()) as { id: string }).id);
    });

    it("queues from the form and sends the reader to the job page", async () => {
        const response = await app.request("/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: `${site.origin}/?form=${Date.now()}` }).toString() });
        assert.equal(response.status, 303);
        assert.match(response.headers.get("location") ?? "", /^\/jobs\/[\da-f-]{36}$/);
    });

    it("refuses a client over its bucket", async () => {
        settings = settingsOf({ "allow-private": true, clients: { rate: { jobs: 1, per: "1h" } }, policies: [{ name: "open", hosts: ["127.0.0.1"], caps: { "max-pages": 1 } }] });
        await post();
        const refused = await post();
        assert.equal(refused.status, 429);
    });
});
