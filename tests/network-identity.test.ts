// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Answer } from "dns-packet";
import { Bucket } from "../src/cache/index.ts";
import { dnsClient, type DnsClient, type StoredReply } from "../src/crawl/dns.ts";
import type { Probe } from "../src/crawl/probe.ts";
import { log } from "../src/logger.ts";
import network from "../src/plugins/network.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import { compileRulesets } from "../src/rules/rulesets.ts";
import { runRules } from "../src/rules/run.ts";
import { serveDns, soa, type DnsFixture } from "./fixtures/dns.ts";

function record(type: string, name: string, data: unknown): { answers: Answer[] } {
    return { answers: [{ type, name, ttl: 300, data } as Answer] };
}

// The reverse name of an address under `suffix`, octets or nibbles last first.
function reverse(address: string, suffix: string): string {
    return `${(address.includes(".") ? address.split(".") : [...address]).toReversed().join(".")}.${suffix}`;
}

// `ok.fixture` passes every network rule; `net.fixture` sits in an invalid route with a PTR-less MX and one ASN; `far.fixture`’s MX PTR names another host.
const ZONES = {
    "ok.fixture|SOA": { answers: [soa("ok.fixture", 1)] },
    "ok.fixture|A": record("A", "ok.fixture", "192.0.2.10"),
    "ok.fixture|AAAA": record("AAAA", "ok.fixture", "2001:db8::10"),
    "ok.fixture|MX": record("MX", "ok.fixture", { preference: 10, exchange: "mx.ok.fixture" }),
    "ok.fixture|NS": record("NS", "ok.fixture", "ns.ok.fixture"),
    "mx.ok.fixture|A": record("A", "mx.ok.fixture", "192.0.2.25"),
    "ns.ok.fixture|A": record("A", "ns.ok.fixture", "198.51.100.53"),
    [`${reverse("192.0.2.10", "in-addr.arpa")}|PTR`]: record("PTR", "x", "ok.fixture"),
    [`${reverse("20010db8000000000000000000000010", "ip6.arpa")}|PTR`]: record("PTR", "x", "ok.fixture."),
    [`${reverse("192.0.2.25", "in-addr.arpa")}|PTR`]: record("PTR", "x", "mx.ok.fixture"),
    [`${reverse("192.0.2.10", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64500 | 192.0.2.0/24 | NL | ripencc | 2020-01-01"]),
    [`${reverse("192.0.2.25", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64500 | 192.0.2.0/24 | NL | ripencc | 2020-01-01"]),
    [`${reverse("192.0.2.26", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64500 | 192.0.2.0/24 | NL | ripencc | 2020-01-01"]),
    [`${reverse("20010db8000000000000000000000010", "origin6.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64500 | 2001:db8::/32 | NL | ripencc | 2020-01-01"]),
    [`${reverse("198.51.100.53", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64501 64511 | 198.51.100.0/24 | DE | ripencc | 2020-01-01"]),
    "AS64500.asn.cymru.com|TXT": record("TXT", "x", ["64500 | NL | ripencc | 2020-01-01 | EXAMPLE-NET - Example Net, NL"]),
    "AS64501.asn.cymru.com|TXT": record("TXT", "x", ["64501 | DE | ripencc | 2020-01-01 | OTHER-NET - Other Net, DE"]),
    "net.fixture|SOA": { answers: [soa("net.fixture", 1)] },
    "net.fixture|A": record("A", "net.fixture", "203.0.113.10"),
    "net.fixture|MX": record("MX", "net.fixture", { preference: 10, exchange: "mx.net.fixture" }),
    "net.fixture|NS": record("NS", "net.fixture", "ns.net.fixture"),
    "mx.net.fixture|A": record("A", "mx.net.fixture", "203.0.113.25"),
    "ns.net.fixture|A": record("A", "ns.net.fixture", "203.0.113.53"),
    [`${reverse("203.0.113.10", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64502 | 203.0.113.0/24 | US | arin | 2020-01-01"]),
    [`${reverse("203.0.113.25", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64502 | 203.0.113.0/24 | US | arin | 2020-01-01"]),
    [`${reverse("203.0.113.53", "origin.asn.cymru.com")}|TXT`]: record("TXT", "x", ["64502 | 203.0.113.0/24 | US | arin | 2020-01-01"]),
    "far.fixture|SOA": { answers: [soa("far.fixture", 1)] },
    "far.fixture|A": record("A", "far.fixture", "192.0.2.10"),
    "far.fixture|MX": record("MX", "far.fixture", { preference: 10, exchange: "mx.far.fixture" }),
    "far.fixture|NS": record("NS", "far.fixture", "ns.ok.fixture"),
    "mx.far.fixture|A": record("A", "mx.far.fixture", "192.0.2.26"),
    [`${reverse("192.0.2.26", "in-addr.arpa")}|PTR`]: record("PTR", "x", "mail.elsewhere.fixture"),
    "mail.elsewhere.fixture|A": record("A", "mail.elsewhere.fixture", "192.0.2.99"),
};

// RIPEstat’s status for each route the fixtures announce.
const ROUTES: Record<string, string> = { "AS64500 192.0.2.0/24": "valid", "AS64500 2001:db8::/32": "valid", "AS64501 198.51.100.0/24": "unknown", "AS64502 203.0.113.0/24": "invalid_asn" };

// A RIPEstat stand-in answering from `ROUTES`, recording every URL asked.
function ripestat(asked: string[]): SiteContext["delegated"] {
    return async (url) => {
        asked.push(url);
        const query = new URL(url).searchParams;
        return { url, status: 200, headers: {}, redirects: [], ms: 0, body: JSON.stringify({ data: { status: ROUTES[`${query.get("resource")} ${query.get("prefix")}`] ?? "unknown" } }) } satisfies Probe;
    };
}

async function extract(host: string, client: DnsClient, asked: string[] = [], isRpki = true): Promise<Record<string, unknown> | undefined> {
    const context = { pages: [], signal: new AbortController().signal, dns: client, delegated: ripestat(asked), settings: { rpki: isRpki } } as unknown as SiteContext;
    return (await network.sites?.[0]?.extract(host, context)) as Record<string, unknown> | undefined;
}

// `[rule, host]` of every finding of the `network` preset, hints included, sorted.
function findings(hosts: Record<string, Record<string, unknown> | undefined>): [string, string][] {
    const site = { sitemaps: [], hosts: Object.fromEntries(Object.entries(hosts).map(([host, facts]) => [host, { network: facts }])) };
    return runRules([], new Map([["default", compileRulesets(["network"], {})]]), site)
        .findings.map((finding): [string, string] => [finding.rule, finding.url])
        .toSorted(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
}

function off(): Bucket<StoredReply> {
    return new Bucket<StoredReply>("dns", undefined, 60, "off");
}

describe("network plugin", () => {
    let fixture: DnsFixture;
    let down: DnsFixture;

    before(async () => {
        const cymru = Object.keys(ZONES).filter((key) => key.includes(".cymru.com|"));
        const unreachable = Object.fromEntries(cymru.map((key) => [key, { rcode: "SERVFAIL" }]));
        [fixture, down] = await Promise.all([serveDns(true, ZONES), serveDns(true, { ...ZONES, ...unreachable })]);
    });

    after(async () => {
        await Promise.all([fixture.close(), down.close()]);
    });

    it("reads the origin, holder, registry country, RPKI state and reverse DNS of every address", async () => {
        const facts = await extract("ok.fixture", dnsClient(fixture.server, off(), false));
        assert.deepEqual(facts, {
            web: [
                { address: "192.0.2.10", asn: 64_500, prefix: "192.0.2.0/24", holder: "EXAMPLE-NET - Example Net, NL", "registry-country": "NL", ptr: ["ok.fixture"], fcrdns: true, rpki: "valid" },
                { address: "2001:db8::10", asn: 64_500, prefix: "2001:db8::/32", holder: "EXAMPLE-NET - Example Net, NL", "registry-country": "NL", ptr: ["ok.fixture"], fcrdns: true, rpki: "valid" },
            ],
            mail: [{ address: "192.0.2.25", name: "mx.ok.fixture", asn: 64_500, prefix: "192.0.2.0/24", holder: "EXAMPLE-NET - Example Net, NL", "registry-country": "NL", ptr: ["mx.ok.fixture"], fcrdns: true, rpki: "valid" }],
            nameservers: [{ address: "198.51.100.53", name: "ns.ok.fixture", asn: 64_501, prefix: "198.51.100.0/24", holder: "OTHER-NET - Other Net, DE", "registry-country": "DE", ptr: [], fcrdns: false, rpki: "not-found" }],
            asns: ["AS64500", "AS64501"],
        });
    });

    it("finds an invalid route, an MX without PTR and an MX whose PTR names another host, once each", async () => {
        const client = dnsClient(fixture.server, off(), false);
        const hosts = { "ok.fixture": await extract("ok.fixture", client), "net.fixture": await extract("net.fixture", client), "far.fixture": await extract("far.fixture", client) };
        assert.deepEqual(findings(hosts), [
            ["network/mail-fcrdns", "far.fixture"],
            ["network/mail-fcrdns", "net.fixture"],
            ["network/rpki-invalid", "net.fixture"],
            ["network/single-asn", "net.fixture"],
        ]);
    });

    it("asks RIPEstat once per route, and never with rpki off", async () => {
        const asked: string[] = [];
        await extract("ok.fixture", dnsClient(fixture.server, off(), false), asked);
        assert.equal(asked.length, 3);
        assert.ok(asked.every((url) => url.startsWith("https://stat.ripe.net/data/rpki-validation/data.json?")));
        const quiet: string[] = [];
        const facts = await extract("ok.fixture", dnsClient(fixture.server, off(), false), quiet, false);
        assert.deepEqual(quiet, []);
        assert.equal((facts?.web as { rpki?: string }[])[0]?.rpki, undefined);
    });

    it("skips the routing facts with one warning when the Cymru zone does not answer", async (t) => {
        const warn = t.mock.method(log, "warn");
        const client = dnsClient(down.server, off(), false);
        const hosts = { "ok.fixture": await extract("ok.fixture", client), "far.fixture": await extract("far.fixture", client) };
        assert.equal(warn.mock.callCount(), 1);
        assert.equal("asns" in (hosts["ok.fixture"] ?? {}), false);
        assert.equal("asn" in ((hosts["ok.fixture"]?.web as object[])[0] ?? {}), false);
        assert.deepEqual(findings(hosts), [["network/mail-fcrdns", "far.fixture"]]);
    });

    it("never queries a special-use name", async () => {
        const client = dnsClient("127.0.0.1:9", off(), false);
        assert.equal(await extract("printer.local", client), undefined);
    });
});
