// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bucket, type BucketName } from "../src/cache/index.ts";
import { ConfigError } from "../src/config/index.ts";
import { dnsClient, parseResolver, servers, type DnsClient, type StoredReply } from "../src/crawl/dns.ts";
import { parseSvcb } from "../src/crawl/svcb.ts";
import type { Facts, SiteFacts } from "../src/facts/types.ts";
import dns, { isSpecialUse } from "../src/plugins/dns.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { serveDns, svcb, type DnsFixture } from "./fixtures/dns.ts";

// A page on `host` served by `issuer`, linking `links` and advertising `altSvc`.
function page(host: string, issuer: string, links: string[] = [], altSvc?: string): Facts {
    const href = `https://${host}/`;
    return { url: { href, origin: `https://${host}`, protocol: "https:", host, pathname: "/", search: "" }, group: "default", crawl: { depth: 0, discoveredVia: "seed", referrers: [] }, http: { status: 200, redirects: [], headers: altSvc ? { "alt-svc": altSvc } : {}, timing: {}, cookies: [], size: { body: 0, decoded: 0 }, contentType: "text/html" }, tls: { cert: { issuer, san: [host] } }, html: { links: { internal: [], external: links, nofollow: [] } } } as unknown as Facts;
}

function off(): Bucket<StoredReply> {
    return new Bucket<StoredReply>("dns", undefined, 60, "off");
}

// Every dns extractor’s facts for `host`, keyed as the site document holds them.
async function extract(host: string, pages: Facts[], client: DnsClient): Promise<Record<string, unknown>> {
    const signal = new AbortController().signal;
    const context = { pages, signal, dns: client, fetch: () => Promise.reject(new Error("no http here")), link: () => Promise.reject(new Error("no http here")) };
    const facts: Record<string, unknown> = {};
    const extractors = dns.sites ?? [];
    for (const extractor of extractors) {
        const value = await extractor.extract(host, context);
        if (value !== undefined) facts[extractor.id] = value;
    }
    return facts;
}

// Rule IDs `preset` reports over a site document of these hosts, sorted.
function findings(hosts: Record<string, Record<string, unknown>>, preset = "dns"): string[] {
    const site: SiteFacts = { sitemaps: [], hosts };
    const run = runRules([], new Map([["default", compileRulesets([preset], {})]]), site);
    return run.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("resolver setting", () => {
    it("accepts system and address lists, and refuses anything else", () => {
        assert.equal(parseResolver("system"), "system");
        assert.deepEqual(servers(parseResolver("9.9.9.9, [2620:fe::fe]:5353,::1")), [{ address: "9.9.9.9", port: 53 }, { address: "2620:fe::fe", port: 5353 }, { address: "::1", port: 53 }]);
        assert.throws(() => parseResolver("dns.quad9.net"), ConfigError);
        assert.throws(() => parseResolver("9.9.9.9:99999"), ConfigError);
    });
});

describe("svcb parser", () => {
    it("reads the RFC 9460 appendix D vectors", () => {
        assert.deepEqual(parseSvcb(Buffer.from("000103666f6f076578616d706c6503636f6d00", "hex")), { priority: 1, target: "foo.example.com" });
        assert.deepEqual(parseSvcb(Buffer.from('001003666f6f076578616d706c6503636f6d00000300020035', "hex")), { priority: 16, target: "foo.example.com", port: 53 });
        assert.deepEqual(parseSvcb(Buffer.from('0001000006002020010db800000000000000000000000120010db8000000000000000000530001', "hex")), { priority: 1, target: ".", ipv6hint: ["2001:db8::1", "2001:db8::53:1"] });
    });

    it("reads every key it knows and names the rest", () => {
        const data = svcb(1, "svc.example", [[0, Buffer.from([0, 1])], [1, Buffer.from([2, 0x68, 0x32, 2, 0x68, 0x33])], [2, Buffer.alloc(0)], [4, Buffer.from([192, 0, 2, 1, 192, 0, 2, 2])], [5, Buffer.from([0, 1, 2])], [667, Buffer.from("hi")]]);
        assert.deepEqual(parseSvcb(data), { priority: 1, target: "svc.example", mandatory: ["alpn"], alpn: ["h2", "h3"], noDefaultAlpn: true, ipv4hint: ["192.0.2.1", "192.0.2.2"], ech: true, unknown: [667] });
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
        assert.deepEqual(reply.answers.map((record) => (record as { data: unknown }).data), ["192.0.2.9"]);
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
        assert.deepEqual((facts.dnssec as { nsec3: object }).nsec3, { iterations: 0, saltLength: 0 });
    });

    it("finds each fault of a bad zone", async () => {
        const facts = await extract("www.bad.fixture", [page("www.bad.fixture", "Let's Encrypt", ["https://old.bad.fixture/x", "https://elsewhere.example/"])], dnsClient(fixture.server, off(), true, fixture.port));
        assert.equal((facts.dns as { zone: string }).zone, "bad.fixture");
        assert.deepEqual(findings({ "www.bad.fixture": facts }), ["dns/aaaa", "dns/caa", "dns/cname-chain", "dns/dangling-cname", "dns/dnssec-algorithm", "dns/https-record", "dns/ns-consistent", "dns/ns-count", "dns/ns-diversity", "dns/nsec3-iterations", "dns/rrsig-expiry"]);
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

    it("passes a name that sends no mail and fails each dns:mail rule on one that does", async () => {
        const quiet = await extract("quiet.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual(quiet.mail, { mx: [{ preference: 0, exchange: "." }], spf: ["v=spf1 -all"], dmarc: { at: "quiet.fixture", record: "v=DMARC1; p=reject", policy: "reject" } });
        assert.deepEqual(findings({ "quiet.fixture": quiet }, "dns:mail"), []);
        const sending = await extract("www.bad.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal((sending.mail as { dmarc: { policy: string } }).dmarc.policy, "none", "a subdomain takes the organisational sp= policy");
        assert.deepEqual(findings({ "www.bad.fixture": sending }, "dns:mail"), ["dns/dmarc-reject", "dns/null-mx", "dns/spf-none"]);
        const silent = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual(findings({ "good.fixture": silent }, "dns:mail"), ["dns/dmarc-reject", "dns/null-mx", "dns/spf-none"]);
    });

    it("records _for-sale and _agents as facts only", async () => {
        const facts = await extract("quiet.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual((facts.dns as { forSale: string[] }).forSale, ["v=FORSALE1;fcod=XX-NGYyYjEyZWY"]);
        assert.deepEqual((facts.dns as { agents: object[] }).agents, [{ priority: 1, target: "agents.quiet.fixture", alpn: ["h2"] }]);
        const plainZone = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.equal("forSale" in (plainZone.dns as object), false);
    });

    it("never asks a name server directly when direct queries are off", async () => {
        const facts = await extract("good.fixture", [], dnsClient(fixture.server, off(), false));
        assert.deepEqual((facts.nameservers as { servers: object[] }).servers.map((server) => Object.keys(server)), [["name", "addresses"], ["name", "addresses"]]);
        await assert.rejects(dnsClient(fixture.server, off(), false).query("good.fixture", "SOA", { server: "127.0.0.1" }), /refused/);
    });
});
