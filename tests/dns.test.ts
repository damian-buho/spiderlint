// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bucket, type BucketName } from "../src/cache/index.ts";
import { ConfigError } from "../src/config/index.ts";
import type { Answer } from "dns-packet";
import { dnsClient, parseResolver, servers, type DnsClient, type Reply, type StoredReply } from "../src/crawl/dns.ts";
import type { Probe, ProbeInit } from "../src/crawl/probe.ts";
import { BOOTSTRAP } from "../src/crawl/rdap.ts";
import { parseSvcb } from "../src/crawl/svcb.ts";
import { extractSites } from "../src/facts/sites.ts";
import type { Facts, LinkFacts, SiteFacts } from "../src/facts/types.ts";
import { dnsProvider } from "../src/facts/vendors.ts";
import dns, { isSpecialUse } from "../src/plugins/dns.ts";
import mail from "../src/plugins/mail.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import { FILES, serveDns, soa, svcb, type DnsFixture } from "./fixtures/dns.ts";

// A page on `host` served by `issuer`, linking `links` and advertising `altSvc`.
function page(host: string, issuer: string, links: string[] = [], altSvc?: string): Facts {
    const href = `https://${host}/`;
    return {
        url: { href, origin: `https://${host}`, protocol: "https:", host, pathname: "/", search: "" },
        group: "default",
        crawl: { depth: 0, "discovered-via": "seed", referrers: [] },
        http: { status: 200, redirects: [], headers: altSvc ? { "alt-svc": altSvc } : {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, "content-type": "text/html" },
        tls: { cert: { issuer, san: [host] } },
        html: { links: { internal: [], external: links, nofollow: [] } },
    } as unknown as Facts;
}

// A stub reply carrying `answers`, authoritative when `isAuthoritative`.
function reply(answers: Answer[], isAuthoritative = false): Reply {
    return { server: "stub", rcode: "NOERROR", aa: isAuthoritative, ad: false, ra: false, answers, authorities: [] };
}

function a(name: string, data: string): Answer {
    return { type: "A", name, ttl: 300, data };
}

function off(): Bucket<StoredReply> {
    return new Bucket<StoredReply>("dns", undefined, 60, "off");
}

// A file from the fixture table, or a refusal for any other URL.
async function delegated(url: string): Promise<Probe> {
    const body = FILES[url];
    if (body === undefined) throw new Error(`no http here: ${url}`);
    return { url, status: 200, headers: { "content-type": url.endsWith(".svg") ? "image/svg+xml" : "text/plain" }, body, redirects: [], ms: 1 };
}

// Every dns and mail extractor’s facts for `host`, keyed as the site document holds them; `mailSettings` as `org.spiderlint.mail`.
async function extract(host: string, pages: Facts[], client: DnsClient, mailSettings: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const signal = new AbortController().signal;
    const context = {
        pages,
        signal,
        dns: client,
        settings: { compare: [], rdap: false },
        fetch: () => Promise.reject(new Error("no http here")),
        delegated,
        link: () => Promise.reject(new Error("no http here")),
        cached: () => Promise.reject(new Error("no http here")),
        address: () => Promise.reject(new Error("no socket here")),
    };
    const facts: Record<string, unknown> = {};
    const extractors = [...(dns.sites ?? []), ...(mail.sites ?? [])];
    for (const extractor of extractors) {
        const value = await extractor.extract(host, mail.sites?.includes(extractor) ? { ...context, settings: mailSettings } : context);
        if (value !== undefined) facts[extractor.id] = value;
    }
    return facts;
}

// Rule IDs `preset` reports over a site document, sorted.
function findings(hosts: Record<string, Record<string, unknown>>, preset = "dns", linked?: string[]): string[] {
    return keyed({ sitemaps: [], hosts, ...(linked && { linked }) }, preset).map(([rule]) => rule);
}

// `[rule, subject]` of every finding `preset` reports over `site`, sorted.
function keyed(site: SiteFacts, preset: string): [string, string][] {
    const run = runRules([], new Map([["default", compileRulesets([preset], {})]]), site);
    return run.findings.map((finding): [string, string] => [finding.rule, finding.url]).toSorted(([a], [b]) => a.localeCompare(b));
}

describe("resolver setting", () => {
    it("accepts system and address lists, and refuses anything else", () => {
        assert.equal(parseResolver("system"), "system");
        assert.deepEqual(servers(parseResolver("9.9.9.9, [2620:fe::fe]:5353,::1")), [
            { address: "9.9.9.9", port: 53 },
            { address: "2620:fe::fe", port: 5353 },
            { address: "::1", port: 53 },
        ]);
        assert.throws(() => parseResolver("dns.quad9.net"), ConfigError);
        assert.throws(() => parseResolver("9.9.9.9:99999"), ConfigError);
    });
});

describe("svcb parser", () => {
    it("reads the RFC 9460 appendix D vectors", () => {
        assert.deepEqual(parseSvcb(Buffer.from("000103666f6f076578616d706c6503636f6d00", "hex")), { priority: 1, target: "foo.example.com" });
        assert.deepEqual(parseSvcb(Buffer.from("001003666f6f076578616d706c6503636f6d00000300020035", "hex")), { priority: 16, target: "foo.example.com", port: 53 });
        assert.deepEqual(parseSvcb(Buffer.from("0001000006002020010db800000000000000000000000120010db8000000000000000000530001", "hex")), { priority: 1, target: ".", ipv6hint: ["2001:db8::1", "2001:db8::53:1"] });
    });

    it("reads every key it knows and names the rest", () => {
        const data = svcb(1, "svc.example", [
            [0, Buffer.from([0, 1])],
            [1, Buffer.from([2, 0x68, 0x32, 2, 0x68, 0x33])],
            [2, Buffer.alloc(0)],
            [4, Buffer.from([192, 0, 2, 1, 192, 0, 2, 2])],
            [5, Buffer.from([0, 1, 2])],
            [667, Buffer.from("hi")],
        ]);
        assert.deepEqual(parseSvcb(data), { priority: 1, target: "svc.example", mandatory: ["alpn"], alpn: ["h2", "h3"], "no-default-alpn": true, ipv4hint: ["192.0.2.1", "192.0.2.2"], ech: true, unknown: [667] });
    });
});

describe("special-use names", () => {
    it("are never queried", async () => {
        const client = dnsClient("127.0.0.1:9", off(), true);
        for (const host of ["localhost", "app.localhost", "site.test", "x.invalid", "printer.local", "abc.onion", "abc.b32.i2p", "router.home.arpa", "svc.internal", "127.0.0.1"]) {
            assert.equal(isSpecialUse(host) || host === "127.0.0.1", true, host);
            assert.deepEqual(await extract(host, [], client), {}, host);
        }
    });
});

describe("dns plugin", () => {
    let fixture: DnsFixture;
    let plain: DnsFixture;
    let directory: string;

    before(async () => {
        [fixture, plain] = await Promise.all([serveDns(), serveDns(false)]);
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-dns-"));
    });

    after(async () => {
        await Promise.all([fixture.close(), plain.close()]);
        await rm(directory, { recursive: true, force: true });
    });

    it("falls back to TCP on a truncated answer and caches for the record TTL", async () => {
        const bucket = new Bucket<StoredReply>("dns" as BucketName, path.join(directory, "dns"), 60, "use");
        const client = dnsClient(fixture.server, bucket, false);
        const reply = await client.query("big.good.fixture", "A");
        assert.deepEqual(
            reply.answers.map((record) => (record as { data: unknown }).data),
            ["192.0.2.9"],
        );
        const asked = fixture.queries.length;
        await client.query("big.good.fixture", "A");
        assert.equal(fixture.queries.length, asked, "the second answer comes from the bucket");
        const entry = await bucket.get(`${fixture.server}\tbig.good.fixture\tA\t`);
        assert.ok(entry && Date.parse(entry.value.expires) - Date.now() > 250_000);
    });

    it("finds nothing wrong with a good zone", async () => {
        const facts = await extract("good.fixture", [page("good.fixture", "Let's Encrypt", [], 'h3=":443"; ma=86400')], dnsClient(fixture.server, off(), true, fixture.port));
        assert.deepEqual(findings({ "good.fixture": facts }), []);
        assert.deepEqual((facts.nameservers as { serials: number[] }).serials, [7]);
        assert.deepEqual((facts.dnssec as { nsec3: object }).nsec3, { iterations: 0, "salt-length": 0 });
    });

    it("finds each fault of a bad zone", async () => {
        const facts = await extract("www.bad.fixture", [page("www.bad.fixture", "Let's Encrypt", ["https://old.bad.fixture/x", "https://elsewhere.example/"])], dnsClient(fixture.server, off(), true, fixture.port));
        assert.equal((facts.dns as { zone: string }).zone, "bad.fixture");
        assert.deepEqual(findings({ "www.bad.fixture": facts }), ["dns/aaaa", "dns/caa", "dns/cname-chain", "dns/dnssec-algorithm", "dns/https-record", "dns/ns-consistent", "dns/ns-count", "dns/ns-delegation", "dns/ns-diversity", "dns/nsec3-iterations", "dns/rrsig-expiry", "dns/soa-timers"]);
        assert.deepEqual((facts.nameservers as { delegation: object }).delegation, { servers: ["ns.old-host.fixture", "ns1.bad.fixture"], matches: false });
        assert.equal((facts.nameservers as { soa: { expire: number } }).soa.expire, 3600);
    });

    it("reads the delegation, SOA and authoritative TTLs of a good zone", async () => {
        const facts = await extract("good.fixture", [], dnsClient(fixture.server, off(), true, fixture.port));
        const servers = facts.nameservers as { delegation: object; soa: object; ttl: object };
        assert.deepEqual(servers.delegation, { servers: ["ns1.good.fixture", "ns2.good.fixture"], matches: true });
        assert.deepEqual(servers.soa, { mname: "ns1.good.fixture", refresh: 3600, retry: 600, expire: 1_209_600, minimum: 300, "retry-below-refresh": true, "mname-listed": true });
        assert.deepEqual(servers.ttl, { ns: 300, a: 300, aaaa: 300 });
        assert.deepEqual(
            findings({ "good.fixture": { nameservers: { ...servers, ttl: { a: 30, ns: 300 } } } }).filter((rule) => rule === "dns/ttl"),
            ["dns/ttl"],
        );
    });

    it("names the SOA field out of range and spares a zone whose provider fixes the SOA", () => {
        const timers = { mname: "adam.ns.cloudflare.com", refresh: 10_000, retry: 2400, expire: 604_800, minimum: 1800, "retry-below-refresh": true, "mname-listed": true };
        const run = runRules([], new Map([["default", compileRulesets(["dns/soa-timers"], {})]]), { sitemaps: [], hosts: { "a.fixture": { nameservers: { soa: timers } } } });
        assert.match(run.findings[0]?.message ?? "", /^the SOA expire is 604800, outside/);
        assert.deepEqual(dnsProvider(["adam.ns.cloudflare.com", "Lucy.NS.Cloudflare.com."])?.provider, "Cloudflare");
        assert.deepEqual(dnsProvider(["ns-1.awsdns-01.co.uk", "ns-2.awsdns-02.org"])?.["soa-editable"], true);
        assert.equal(dnsProvider(["adam.ns.cloudflare.com", "ns1.own.fixture"]), undefined);
        const managed = (isEditable: boolean) => findings({ "a.fixture": { nameservers: { soa: timers, provider: { name: "X", "soa-editable": isEditable, docs: "" } } } }).filter((rule) => rule === "dns/soa-timers");
        assert.deepEqual([managed(false), managed(true)], [[], ["dns/soa-timers"]]);
    });

    it("finds a CNAME at the zone apex", async () => {
        const facts = await extract("alias.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((facts.dns as { "apex-cname": string })["apex-cname"], "good.fixture");
        assert.ok(findings({ "alias.fixture": facts }).includes("dns/apex-cname"));
        const good = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((good.dns as { "apex-cname": unknown })["apex-cname"], false);
    });

    it("finds an authoritative server that answers recursive queries", async () => {
        const open = await serveDns(true, { "a.root-servers.net|A": { recursive: true, answers: [a("a.root-servers.net", "198.41.0.4")] } });
        try {
            const facts = await extract("good.fixture", [page("good.fixture", "Let's Encrypt", [], 'h3=":443"')], dnsClient(open.server, off(), true, open.port));
            assert.deepEqual(
                (facts.nameservers as { servers: { recursive: boolean }[] }).servers.map((server) => server.recursive),
                [true, true],
            );
            assert.deepEqual(findings({ "good.fixture": facts }), ["dns/open-recursion"]);
        } finally {
            await open.close();
        }
    });

    it("asks CAA to restrict issuance, name an iodef contact, and keep critical flags off unknown tags", async () => {
        const facts = await extract("good.fixture", [page("good.fixture", "Let's Encrypt", [], 'h3=":443"; ma=86400')], dnsClient(fixture.server, off(), true, fixture.port));
        const caa = (...records: object[]) => ({ "good.fixture": { ...facts, dns: { ...(facts.dns as object), caa: { at: "good.fixture", records } } } });
        const iodef = { flags: 0, tag: "iodef", value: "https://rr.good.fixture" };
        const issue = { flags: 0, tag: "issue", value: "letsencrypt.org" };
        assert.deepEqual(findings(caa(iodef), "dns:core"), ["dns/caa"]);
        assert.deepEqual(findings(caa(issue), "dns:core"), ["dns/caa-iodef"]);
        assert.deepEqual(findings(caa(issue, iodef, { flags: 128, tag: "tbs", value: "x" }), "dns:core"), ["dns/caa-critical"]);
        assert.deepEqual(findings(caa(issue, iodef, { flags: 128, tag: "issuewild", value: ";" }), "dns:core"), []);
    });

    it("judges CAA against the certificate actually served, and h3 against Alt-Svc", async () => {
        const facts = await extract("good.fixture", [page("good.fixture", "Actalis S.p.A.")], dnsClient(fixture.server, off(), false));
        assert.deepEqual(findings({ "good.fixture": facts }), ["dns/caa-issuer", "dns/https-alpn"]);
        const unknown = await extract("good.fixture", [page("good.fixture", "Snake Oil CA", [], 'h3=":443"')], dnsClient(fixture.server, off(), false));
        assert.deepEqual(findings({ "good.fixture": unknown }), []);
    });

    it("reports a bogus zone only through a validating resolver", async () => {
        const validated = await extract("bogus.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((validated.dnssec as { bogus: boolean }).bogus, true);
        assert.ok(findings({ "bogus.fixture": validated }).includes("dns/dnssec-bogus"));
        const unvalidated = await extract("bogus.fixture", [], dnsClient(plain.server, off(), false));
        assert.equal((unvalidated.dnssec as { bogus?: boolean }).bogus, undefined);
    });

    it("holds each name to the dns:mail rules of the intent its MX and SPF declare", async () => {
        const quiet = await extract("quiet.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual(quiet.mail, { mx: [{ preference: 0, exchange: "." }], spf: ["v=spf1 -all"], dmarc: { at: "quiet.fixture", record: "v=DMARC1; p=reject", policy: "reject" }, intent: "none", mode: "none" });
        assert.deepEqual(findings({ "quiet.fixture": quiet }, "dns:mail"), []);
        const sending = await extract("www.bad.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((sending.mail as { dmarc: { policy: string } }).dmarc.policy, "none", "a subdomain takes the organisational sp= policy");
        assert.equal((sending.mail as { intent: string }).intent, "both");
        assert.deepEqual(findings({ "www.bad.fixture": sending }, "dns:mail"), ["dns/dmarc-policy"]);
        const silent = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((silent.mail as { intent: string }).intent, "none");
        assert.deepEqual(findings({ "good.fixture": silent }, "dns:mail"), ["dns/dmarc-reject", "dns/null-mx", "dns/spf-none"]);
        const mixed = await extract("mixed.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((mixed.mail as { intent: string }).intent, "both");
        assert.deepEqual(findings({ "mixed.fixture": mixed }, "dns:mail"), ["dns/dmarc-policy", "dns/null-mx-mixed", "dns/spf-all", "dns/spf-record"]);
    });

    it("finds nothing in a clean mail domain, and one finding per fault in each broken one", async () => {
        const client = dnsClient(fixture.server, off(), false);
        const clean = await extract("clean.fixture", [], client);
        assert.equal((clean.mail as { mode: string }).mode, "mail");
        assert.deepEqual((clean.mail as { "spf-walk": object })["spf-walk"], { errors: [], lookups: 2, "void-lookups": 0, ptr: false, "after-all": [], redundant: [], "missing-includes": [] });
        assert.deepEqual(findings({ "clean.fixture": clean }, "mail"), []);
        const faults: [string, string[]][] = [
            ["lookups.fixture", ["mail/spf-lookups"]],
            ["plusall.fixture", ["dns/spf-all"]],
            ["twospf.fixture", ["dns/spf-record"]],
            ["dmarcnone.fixture", ["dns/dmarc-policy", "mail/dmarc-external"]],
            ["weakdkim.fixture", ["mail/dkim-key"]],
            ["cnamemx.fixture", ["mail/mx-cname"]],
            ["mtasts.fixture", ["mail/mta-sts-mx"]],
        ];
        for (const [domain, expected] of faults) assert.deepEqual(findings({ [domain]: await extract(domain, [], client) }, "mail"), expected, domain);
    });

    it("tells each SPF, DMARC, DKIM, MTA-STS, TLS-RPT and BIMI weakness apart", async () => {
        const facts = await extract("messy.fixture", [], dnsClient(fixture.server, off(), false));
        const messy = facts.mail as Record<string, Record<string, unknown>>;
        assert.deepEqual(messy["spf-walk"], { errors: [], lookups: 4, "void-lookups": 1, ptr: true, "after-all": ["a"], redundant: ["mx"], "missing-includes": ["gone.messy.fixture"] });
        assert.deepEqual([messy.dmarc?.errors, messy.dmarc?.testing, messy.dmarc?.["not-mailto"]], [["bad adkim=x"], true, ["https://reports.messy.fixture/"]]);
        assert.deepEqual(
            (messy.dkim?.found as { selector: string; testing: boolean; revoked: boolean }[]).map(({ selector, testing, revoked }) => [selector, testing, revoked]),
            [
                ["selector1", true, false],
                ["selector2", false, true],
            ],
        );
        assert.deepEqual(messy["tls-rpt"]?.errors, ["rua ftp://messy.fixture/ is neither mailto: nor https:"]);
        assert.deepEqual([(messy["mta-sts"]?.policy as Record<string, unknown>).mode, (messy["mta-sts"]?.policy as Record<string, unknown>).unmatched], ["testing", []]);
        assert.deepEqual((messy.bimi?.logo as { errors: string[] }).errors, ["<script> is not allowed", "href https://elsewhere.fixture/x.png is an external reference", "version is 1.1, not 1.2", "baseProfile is missing, not tiny-ps", "no <title>"]);
        assert.deepEqual(findings({ "messy.fixture": { mail: messy } }, "mail"), [
            "mail/bimi-dmarc",
            "mail/bimi-logo",
            "mail/dkim-revoked",
            "mail/dkim-testing",
            "mail/dmarc-syntax",
            "mail/mta-sts-max-age",
            "mail/mta-sts-mode",
            "mail/spf-after-all",
            "mail/spf-include",
            "mail/spf-ptr",
            "mail/spf-redundant",
            "mail/tls-rpt-syntax",
        ]);
    });

    it("keeps a name without mail to the no-mail rules, and follows a configured mode", async () => {
        const client = dnsClient(fixture.server, off(), false);
        assert.deepEqual(findings({ "quiet.fixture": await extract("quiet.fixture", [], client) }, "mail"), []);
        const forced = await extract("quiet.fixture", [], client, { mode: "mail" });
        assert.equal((forced.mail as { mode: string }).mode, "mail");
        assert.ok(findings({ "quiet.fixture": forced }, "mail").includes("dns/null-mx-mixed"));
        const silenced = await extract("clean.fixture", [], client, { mode: "none" });
        assert.deepEqual(Object.keys(silenced.mail as object), ["mx", "spf", "dmarc", "intent", "mode"]);
    });

    it("runs a domains extractor on each crawled host’s registrable domain too", async () => {
        const seen: string[] = [];
        const probe = {
            id: "probe",
            per: "host" as const,
            domains: true as const,
            cached: false as const,
            extract: async (subject: string, context: SiteContext) => {
                seen.push(`${subject}:${context.pages.length}`);
                return { subject };
            },
        };
        const site: SiteFacts = { sitemaps: [] };
        await extractSites(
            [page("www.clean.fixture", "Let's Encrypt"), page("blog.clean.fixture", "Let's Encrypt")],
            site,
            [probe],
            { allowPrivate: true, concurrency: 1, linkExclude: [], timeout: 60 },
            new Bucket("origins", undefined, 60, "off"),
            dnsClient(fixture.server, off(), false),
            new Bucket<LinkFacts>("probes", undefined, 60, "off"),
        );
        assert.deepEqual(
            seen.toSorted((a, b) => a.localeCompare(b)),
            ["blog.clean.fixture:1", "clean.fixture:2", "www.clean.fixture:1"],
        );
    });

    it("records _for-sale and _agents as facts only", async () => {
        const facts = await extract("quiet.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual((facts.dns as { "for-sale": string[] })["for-sale"], ["v=FORSALE1;fcod=XX-NGYyYjEyZWY"]);
        assert.deepEqual((facts.dns as { agents: object[] }).agents, [{ priority: 1, target: "agents.quiet.fixture", alpn: ["h2"] }]);
        const plainZone = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal("for-sale" in (plainZone.dns as object), false);
    });

    it("judges a resource host under the crawled domain as its own subject, for linked rules only", async () => {
        const home = page("www.bad.fixture", "Let's Encrypt", ["https://elsewhere.example/"]);
        home.resources = [{ url: "https://old.bad.fixture/app.js", kind: "script", origin: "cross" }] as Facts["resources"];
        const site: SiteFacts = { sitemaps: [] };
        const client = dnsClient(fixture.server, off(), false);
        const active = (dns.sites ?? []).filter((extractor) => extractor.id === "dns");
        await extractSites([home], site, active, { allowPrivate: true, concurrency: 1, linkExclude: [], timeout: 60 }, new Bucket("origins", undefined, 60, "off"), client, new Bucket<LinkFacts>("probes", undefined, 60, "off"), undefined, new Set(["dns"]));
        assert.deepEqual(site.linked, ["old.bad.fixture"]);
        assert.deepEqual(site.hosts?.["old.bad.fixture"]?.dns, { cname: [{ name: "old.bad.fixture", target: "gone.elsewhere.fixture", ttl: 300 }], dangling: "gone.elsewhere.fixture" });
        assert.equal((site.hosts?.["www.bad.fixture"]?.dns as { dangling: unknown }).dangling, false);
        const reported = keyed(site, "dns");
        assert.deepEqual(
            reported.filter(([rule]) => rule === "dns/dangling-cname"),
            [["dns/dangling-cname", "old.bad.fixture"]],
        );
        assert.ok(
            reported.every(([rule, subject]) => subject === "www.bad.fixture" || rule === "dns/dangling-cname"),
            "only the linked rule judges the linked host",
        );
    });

    it("finds name servers answering the host apart from each other and from the resolver", async () => {
        const direct: Record<string, string> = { "192.0.2.53": "198.51.100.1", "192.0.2.54": "198.51.100.2" };
        const stub: DnsClient = {
            canQueryDirectly: true,
            validating: async () => false,
            async query(name, type, options = {}) {
                if (type === "SOA") return reply(name === "split.fixture" ? [soa("split.fixture", 1)] : [], options.server !== undefined);
                if (type === "NS")
                    return reply([
                        { type: "NS", name, ttl: 300, data: "ns1.split.fixture" },
                        { type: "NS", name, ttl: 300, data: "ns2.split.fixture" },
                    ]);
                if (type !== "A") return reply([]);
                if (options.server) return reply([a(name, direct[options.server] as string)], true);
                return reply([a(name, name === "ns1.split.fixture" ? "192.0.2.53" : name === "ns2.split.fixture" ? "192.0.2.54" : "203.0.113.9")]);
            },
        };
        const nameservers = dns.sites?.find((site) => site.id === "nameservers");
        const facts = (await nameservers?.extract("split.fixture", { pages: [], signal: new AbortController().signal, dns: stub } as unknown as SiteContext)) as Record<string, unknown>;
        assert.deepEqual([facts["answer-sets"], facts["resolver-agrees"], facts.resolver], [2, false, ["A 203.0.113.9"]]);
        assert.deepEqual(
            findings({ "split.fixture": { nameservers: facts } }).filter((rule) => /^dns\/ns-(answers|resolver)$/.test(rule)),
            ["dns/ns-answers", "dns/ns-resolver"],
        );
    });

    it("compares public resolvers only when asked, and names their disagreements", async () => {
        const other = await serveDns(false, { "good.fixture|A": { answers: [{ type: "A", name: "good.fixture", ttl: 300, data: "192.0.2.77" }] } });
        try {
            const resolvers = dns.sites?.find((site) => site.id === "resolvers");
            const context = (compare: string[]) => ({ pages: [], signal: new AbortController().signal, dns: dnsClient(fixture.server, off(), true, fixture.port), settings: { compare } }) as unknown as SiteContext;
            assert.equal(await resolvers?.extract("good.fixture", context([])), undefined);
            const good = (await resolvers?.extract("good.fixture", context([other.server]))) as Record<string, unknown>;
            assert.deepEqual([good.rcodes, good["answer-sets"], good.validated], [["NOERROR"], 2, [true, false]]);
            const bogus = (await resolvers?.extract("bogus.fixture", context([plain.server]))) as Record<string, unknown>;
            assert.deepEqual(bogus.rcodes, ["SERVFAIL", "NOERROR"]);
            assert.deepEqual(
                findings({ "good.fixture": { resolvers: good, dnssec: { signed: true } }, "bogus.fixture": { resolvers: bogus } }).filter((rule) => rule.startsWith("dns/resolver-")),
                ["dns/resolver-answers", "dns/resolver-rcode", "dns/resolver-validation"],
            );
        } finally {
            await other.close();
        }
    });

    it("never asks a name server directly when direct queries are off", async () => {
        const facts = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual(
            (facts.nameservers as { servers: object[] }).servers.map((server) => Object.keys(server)),
            [
                ["name", "addresses"],
                ["name", "addresses"],
            ],
        );
        await assert.rejects(dnsClient(fixture.server, off(), false).query("good.fixture", "SOA", { server: "127.0.0.1" }), /refused/);
    });
});

// A registry answering one RDAP domain object per fixture domain, and the bootstrap that points `fixture` at it.
function serveRegistry(requests: string[]): Promise<Server> {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    const domains: Record<string, object> = {
        "expiring.fixture": { status: ["client transfer prohibited"], events: [{ eventAction: "expiration", eventDate: soon }], nameservers: [{ ldhName: "NS1.EXPIRING.FIXTURE." }] },
        "unlocked.fixture": { status: ["active"], events: [{ eventAction: "expiration", eventDate: far }], nameservers: [{ ldhName: "ns1.unlocked.fixture" }] },
        "moved.fixture": { status: ["client transfer prohibited"], events: [{ eventAction: "expiration", eventDate: far }], nameservers: [{ ldhName: "ns1.old-host.fixture" }] },
    };
    const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const body = request.url === "/bootstrap" ? { services: [[["fixture"], [`${origin}/rdap/`]]] } : domains[(request.url ?? "").replace("/rdap/domain/", "")];
        response.writeHead(body ? 200 : 404, { "content-type": "application/rdap+json" }).end(JSON.stringify(body ?? {}));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("rdap", () => {
    const requests: string[] = [];
    const saved = process.env.XDG_CACHE_HOME;
    let registry: Server;
    let directory: string;
    const rdap = dns.sites?.find((site) => site.id === "rdap");
    // The run’s probe, with the IANA bootstrap served by the fixture registry.
    const get = async (url: string, init: ProbeInit = {}): Promise<Probe> => {
        const target = url === BOOTSTRAP ? `http://127.0.0.1:${(registry.address() as AddressInfo).port}/bootstrap` : url;
        const response = await fetch(target, { headers: init.headers });
        return { url: target, status: response.status, headers: {}, body: await response.text(), redirects: [], ms: 0 };
    };
    // A zone whose NS set is `ns1.<name>`; each context is a run of its own.
    const zone: DnsClient = { canQueryDirectly: false, validating: async () => false, query: async (name, type) => reply(type === "NS" ? [{ type: "NS", name, ttl: 300, data: `ns1.${name}` }] : []) };
    const context = (isAsked = true) => ({ pages: [], signal: new AbortController().signal, dns: { ...zone, validating: async () => false }, delegated: get, settings: { compare: [], rdap: isAsked } }) as unknown as SiteContext;

    before(async () => {
        directory = await mkdtemp(path.join(tmpdir(), "spiderlint-rdap-"));
        process.env.XDG_CACHE_HOME = directory;
        registry = await serveRegistry(requests);
    });

    after(async () => {
        process.env.XDG_CACHE_HOME = saved;
        await new Promise((resolve) => registry.close(resolve));
        await rm(directory, { recursive: true, force: true });
    });

    it("sends no RDAP request when rdap is off", async () => {
        assert.equal(await rdap?.extract("www.expiring.fixture", context(false)), undefined);
        assert.deepEqual(requests, []);
    });

    it("finds an expiring, an unlocked and a moved domain, one finding each", async () => {
        const run = context();
        const hosts = Object.fromEntries(await Promise.all(["www.expiring.fixture", "unlocked.fixture", "moved.fixture"].map(async (host) => [host, { rdap: await rdap?.extract(host, run) }])));
        assert.deepEqual(keyed({ sitemaps: [], hosts }, "dns"), [
            ["domain/expiring", "www.expiring.fixture"],
            ["domain/lock", "unlocked.fixture"],
            ["domain/ns-registry", "moved.fixture"],
        ]);
        assert.deepEqual((hosts["www.expiring.fixture"] as { rdap: { nameservers: string[]; "ns-matches": boolean } }).rdap.nameservers, ["ns1.expiring.fixture"]);
        assert.equal(requests.filter((url) => url === "/bootstrap").length, 1, "the bootstrap is fetched once");
        const stored = JSON.parse(await readFile(path.join(directory, "spiderlint", "rdap", "dns.json"), "utf8")) as { services: unknown[] };
        assert.equal(stored.services.length, 1);
    });

    it("reads a fresh stored bootstrap without fetching it, and skips an unknown TLD", async () => {
        requests.length = 0;
        assert.ok(await rdap?.extract("unlocked.fixture", context()));
        assert.equal(await rdap?.extract("site.elsewhere", context()), undefined);
        assert.deepEqual(requests, ["/rdap/domain/unlocked.fixture"]);
    });
});
