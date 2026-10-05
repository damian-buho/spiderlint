// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { generateKeyPairSync } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import dnsPacket, { type Answer, type Packet } from "dns-packet";

export interface DnsFixture {
    server: string;
    port: number;
    queries: string[];
    close(): Promise<void>;
}

interface Zone {
    rcode?: string;
    answers?: Answer[];
    // Sets `AD`; `CD` retries of a `bogus` name answer NOERROR, others SERVFAIL.
    ad?: boolean;
    bogus?: boolean;
    // Truncated over UDP, whole over TCP.
    truncate?: boolean;
    // Direct queries (no `RD`) answered authoritatively.
    authoritative?: boolean;
    // Direct queries answered with these records as a referral, in the authority section.
    referral?: Answer[];
    // Sets `RA` on an answer to a query carrying `RD`, as an open resolver does.
    recursive?: boolean;
}

const FAR = Math.floor(Date.UTC(2099, 0, 1) / 1000);
const SOON = Math.floor(Date.now() / 1000) + 2 * 86_400;

// An SVCB RDATA with keys in ascending order, the shape RFC 9460 §2.2 demands.
export function svcb(priority: number, target: string, parameters: [number, Buffer][]): Buffer {
    const name = target === "." ? [Buffer.from([0])] : [...target.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])];
    const head = Buffer.alloc(2);
    head.writeUInt16BE(priority);
    const encoded = parameters.map(([key, value]) => {
        const prefix = Buffer.alloc(4);
        prefix.writeUInt16BE(key);
        prefix.writeUInt16BE(value.length, 2);
        return Buffer.concat([prefix, value]);
    });
    return Buffer.concat([head, ...name, ...encoded]);
}

function alpn(...ids: string[]): Buffer {
    return Buffer.concat(ids.map((id) => Buffer.concat([Buffer.from([id.length]), Buffer.from(id)])));
}

function rrsig(name: string, expiration: number): Answer {
    return { type: "RRSIG", name, ttl: 300, data: { typeCovered: "A", algorithm: 13, labels: 2, originalTTL: 300, expiration, inception: expiration - 86_400 * 30, keyTag: 1, signersName: name.split(".").slice(-2).join("."), signature: Buffer.alloc(64) } } as Answer;
}

export function soa(name: string, serial: number, expire = 1_209_600): Answer {
    return { type: "SOA", name, ttl: 300, data: { mname: `ns1.${name}`, rname: `hostmaster.${name}`, serial, refresh: 3600, retry: 600, expire, minimum: 300 } } as Answer;
}

// `good.fixture` passes every dns rule; `www.bad.fixture` fails most; `quiet.fixture` passes `dns:mail`; `mixed.fixture` half sets up mail; `bogus.fixture` fails validation.
const ZONES: Record<string, Zone> = {
    ".|SOA": { ad: true, answers: [soa(".", 1)] },
    "fixture|NS": { answers: [{ type: "NS", name: "fixture", ttl: 300, data: "ns.fixture" }] },
    "ns.fixture|A": { answers: [{ type: "A", name: "ns.fixture", ttl: 300, data: "127.0.0.1" }] },
    "alias.fixture|CNAME": { answers: [{ type: "CNAME", name: "alias.fixture", ttl: 300, data: "good.fixture" }] },
    "good.fixture|SOA": { answers: [soa("good.fixture", 7)], authoritative: true },
    "good.fixture|A": { ad: true, answers: [{ type: "A", name: "good.fixture", ttl: 300, data: "192.0.2.1" }, rrsig("good.fixture", FAR)] },
    "good.fixture|AAAA": { answers: [{ type: "AAAA", name: "good.fixture", ttl: 300, data: "2001:db8::1" }] },
    "good.fixture|UNKNOWN_65": {
        answers: [
            {
                type: "UNKNOWN_65",
                name: "good.fixture",
                ttl: 300,
                data: svcb(1, ".", [
                    [1, alpn("h2", "h3")],
                    [4, Buffer.from([192, 0, 2, 1])],
                    [6, Buffer.from("20010db8000000000000000000000001", "hex")],
                ]),
            } as unknown as Answer,
        ],
    },
    "good.fixture|CAA": {
        answers: [
            { type: "CAA", name: "good.fixture", ttl: 300, data: { flags: 0, tag: "issue", value: "letsencrypt.org" } },
            { type: "CAA", name: "good.fixture", ttl: 300, data: { flags: 0, tag: "iodef", value: "mailto:caa@good.fixture" } },
        ],
    },
    "good.fixture|DS": { answers: [{ type: "DS", name: "good.fixture", ttl: 300, data: { keyTag: 1, algorithm: 13, digestType: 2, digest: Buffer.alloc(32) } }] },
    "good.fixture|DNSKEY": { answers: [{ type: "DNSKEY", name: "good.fixture", ttl: 300, data: { flags: 257, algorithm: 13, key: Buffer.alloc(64) } }] },
    "good.fixture|NSEC3PARAM": { answers: [{ type: "NSEC3PARAM", name: "good.fixture", ttl: 300, data: Buffer.from([1, 0, 0, 0, 0]) } as unknown as Answer] },
    "good.fixture|NS": {
        answers: [
            { type: "NS", name: "good.fixture", ttl: 300, data: "ns1.good.fixture" },
            { type: "NS", name: "good.fixture", ttl: 300, data: "ns2.good.fixture" },
        ],
    },
    "ns1.good.fixture|A": { answers: [{ type: "A", name: "ns1.good.fixture", ttl: 300, data: "127.0.0.1" }] },
    "ns2.good.fixture|AAAA": { answers: [{ type: "AAAA", name: "ns2.good.fixture", ttl: 300, data: "::1" }] },
    "ns2.good.fixture|A": { answers: [{ type: "A", name: "ns2.good.fixture", ttl: 300, data: "127.0.0.1" }] },
    "big.good.fixture|A": { truncate: true, answers: [{ type: "A", name: "big.good.fixture", ttl: 300, data: "192.0.2.9" }] },
    "bad.fixture|SOA": { answers: [soa("bad.fixture", 3, 3600)] },
    "www.bad.fixture|A": {
        answers: [
            { type: "CNAME", name: "www.bad.fixture", ttl: 300, data: "a.bad.fixture" },
            { type: "CNAME", name: "a.bad.fixture", ttl: 300, data: "b.bad.fixture" },
            { type: "CNAME", name: "b.bad.fixture", ttl: 300, data: "c.bad.fixture" },
            { type: "A", name: "c.bad.fixture", ttl: 300, data: "198.51.100.1" },
            rrsig("c.bad.fixture", SOON),
        ],
    },
    "bad.fixture|DS": { answers: [{ type: "DS", name: "bad.fixture", ttl: 300, data: { keyTag: 2, algorithm: 5, digestType: 1, digest: Buffer.alloc(20) } }] },
    "bad.fixture|DNSKEY": { answers: [{ type: "DNSKEY", name: "bad.fixture", ttl: 300, data: { flags: 257, algorithm: 5, key: Buffer.alloc(64) } }] },
    "bad.fixture|NSEC3PARAM": { answers: [{ type: "NSEC3PARAM", name: "bad.fixture", ttl: 300, data: Buffer.from([1, 0, 0, 10, 4, 1, 2, 3, 4]) } as unknown as Answer] },
    "bad.fixture|NS": {
        answers: [{ type: "NS", name: "bad.fixture", ttl: 300, data: "ns1.bad.fixture" }],
        referral: [
            { type: "NS", name: "bad.fixture", ttl: 172_800, data: "ns1.bad.fixture" },
            { type: "NS", name: "bad.fixture", ttl: 172_800, data: "ns.old-host.fixture" },
        ],
    },
    "ns1.bad.fixture|A": { answers: [{ type: "A", name: "ns1.bad.fixture", ttl: 300, data: "127.0.0.1" }] },
    "old.bad.fixture|A": { rcode: "NXDOMAIN", answers: [{ type: "CNAME", name: "old.bad.fixture", ttl: 300, data: "gone.elsewhere.fixture" }] },
    "quiet.fixture|SOA": { answers: [soa("quiet.fixture", 1)] },
    "quiet.fixture|MX": { answers: [{ type: "MX", name: "quiet.fixture", ttl: 300, data: { preference: 0, exchange: "." } }] },
    "quiet.fixture|TXT": {
        answers: [
            { type: "TXT", name: "quiet.fixture", ttl: 300, data: ["v=spf1", " -all"] },
            { type: "TXT", name: "quiet.fixture", ttl: 300, data: ["site-verification=1"] },
        ],
    },
    "_dmarc.quiet.fixture|TXT": { answers: [{ type: "TXT", name: "_dmarc.quiet.fixture", ttl: 300, data: ["v=DMARC1; p=reject"] }] },
    "_for-sale.quiet.fixture|TXT": { answers: [{ type: "TXT", name: "_for-sale.quiet.fixture", ttl: 300, data: ["v=FORSALE1;fcod=XX-NGYyYjEyZWY"] }] },
    "_agents.quiet.fixture|UNKNOWN_64": { answers: [{ type: "UNKNOWN_64", name: "_agents.quiet.fixture", ttl: 300, data: svcb(1, "agents.quiet.fixture", [[1, alpn("h2")]]) } as unknown as Answer] },
    "www.bad.fixture|MX": { answers: [{ type: "MX", name: "www.bad.fixture", ttl: 300, data: { preference: 10, exchange: "mail.bad.fixture" } }] },
    "www.bad.fixture|TXT": { answers: [{ type: "TXT", name: "www.bad.fixture", ttl: 300, data: ["v=spf1 include:mail.bad.fixture ~all"] }] },
    "_dmarc.bad.fixture|TXT": { answers: [{ type: "TXT", name: "_dmarc.bad.fixture", ttl: 300, data: ["v=DMARC1; p=reject; sp=none"] }] },
    "mixed.fixture|SOA": { answers: [soa("mixed.fixture", 1)] },
    "mixed.fixture|MX": {
        answers: [
            { type: "MX", name: "mixed.fixture", ttl: 300, data: { preference: 10, exchange: "mx.mixed.fixture" } },
            { type: "MX", name: "mixed.fixture", ttl: 300, data: { preference: 0, exchange: "." } },
        ],
    },
    "mixed.fixture|TXT": {
        answers: [
            { type: "TXT", name: "mixed.fixture", ttl: 300, data: ["v=spf1 mx ?all"] },
            { type: "TXT", name: "mixed.fixture", ttl: 300, data: ["v=spf1 -all"] },
        ],
    },
    "only.fixture|A": { answers: [{ type: "A", name: "only.fixture", ttl: 300, data: "127.0.0.1" }] },
    "bogus.fixture|SOA": { answers: [soa("bogus.fixture", 1)] },
    "bogus.fixture|DS": { answers: [{ type: "DS", name: "bogus.fixture", ttl: 300, data: { keyTag: 3, algorithm: 13, digestType: 2, digest: Buffer.alloc(32) } }] },
    "bogus.fixture|A": { bogus: true, answers: [{ type: "A", name: "bogus.fixture", ttl: 300, data: "192.0.2.3" }] },
};

// A TXT answer, split into 255-byte character-strings.
function txt(name: string, text: string): Zone {
    return { answers: [{ type: "TXT", name, ttl: 300, data: text.match(/.{1,255}/g) ?? [] }] };
}

// A DKIM key record carrying a fresh RSA key of `bits`.
function dkim(bits: number): string {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: bits });
    return `v=DKIM1; k=rsa; p=${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
}

// The `name|TYPE` entries of a mail domain passing every mail rule, `changes` replacing some.
function mailZones(domain: string, changes: Record<string, Zone> = {}): Record<string, Zone> {
    const mx = `mx.${domain}`;
    return {
        [`${domain}|SOA`]: { answers: [soa(domain, 1)] },
        [`${domain}|MX`]: { answers: [{ type: "MX", name: domain, ttl: 300, data: { preference: 10, exchange: mx } }] },
        [`${mx}|A`]: { answers: [{ type: "A", name: mx, ttl: 300, data: "192.0.2.25" }] },
        [`${domain}|TXT`]: txt(domain, `v=spf1 mx include:spf.${domain} -all`),
        [`spf.${domain}|TXT`]: txt(`spf.${domain}`, "v=spf1 ip4:192.0.2.0/24 -all"),
        [`_dmarc.${domain}|TXT`]: txt(`_dmarc.${domain}`, `v=DMARC1; p=reject; sp=reject; rua=mailto:dmarc@${domain}`),
        [`selector1._domainkey.${domain}|TXT`]: txt(`selector1._domainkey.${domain}`, dkim(2048)),
        [`_mta-sts.${domain}|TXT`]: txt(`_mta-sts.${domain}`, "v=STSv1; id=20260101"),
        [`_smtp._tls.${domain}|TXT`]: txt(`_smtp._tls.${domain}`, `v=TLSRPTv1; rua=mailto:tls@${domain}`),
        ...changes,
    };
}

// `clean.fixture` passes the `mail` preset; each other mail domain breaks it once, `messy.fixture` many times.
const MAIL_ZONES: Record<string, Zone> = {
    ...mailZones("clean.fixture"),
    ...mailZones("lookups.fixture", {
        "lookups.fixture|TXT": txt("lookups.fixture", `v=spf1 mx ${Array.from({ length: 10 }, (_, index) => `a:h${index}.lookups.fixture`).join(" ")} -all`),
        ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`h${index}.lookups.fixture|A`, { answers: [{ type: "A", name: `h${index}.lookups.fixture`, ttl: 300, data: "192.0.2.26" }] }])),
    }),
    ...mailZones("plusall.fixture", { "plusall.fixture|TXT": txt("plusall.fixture", "v=spf1 mx include:spf.plusall.fixture +all") }),
    ...mailZones("twospf.fixture", { "twospf.fixture|TXT": { answers: [...(txt("twospf.fixture", "v=spf1 mx -all").answers ?? []), ...(txt("twospf.fixture", "v=spf1 include:spf.twospf.fixture -all").answers ?? [])] } }),
    ...mailZones("dmarcnone.fixture", { "_dmarc.dmarcnone.fixture|TXT": txt("_dmarc.dmarcnone.fixture", "v=DMARC1; p=none; rua=mailto:dmarc@reports.fixture") }),
    ...mailZones("weakdkim.fixture", { "selector1._domainkey.weakdkim.fixture|TXT": txt("selector1._domainkey.weakdkim.fixture", dkim(512)) }),
    ...mailZones("cnamemx.fixture", {
        "mx.cnamemx.fixture|A": {
            answers: [
                { type: "CNAME", name: "mx.cnamemx.fixture", ttl: 300, data: "real.cnamemx.fixture" },
                { type: "A", name: "real.cnamemx.fixture", ttl: 300, data: "192.0.2.25" },
            ],
        },
    }),
    ...mailZones("mtasts.fixture", {
        "mtasts.fixture|MX": {
            answers: [
                { type: "MX", name: "mtasts.fixture", ttl: 300, data: { preference: 10, exchange: "mx.mtasts.fixture" } },
                { type: "MX", name: "mtasts.fixture", ttl: 300, data: { preference: 20, exchange: "backup.mtasts.fixture" } },
            ],
        },
        "backup.mtasts.fixture|A": { answers: [{ type: "A", name: "backup.mtasts.fixture", ttl: 300, data: "192.0.2.27" }] },
    }),
    ...mailZones("messy.fixture", {
        "messy.fixture|TXT": txt("messy.fixture", "v=spf1 ptr mx mx include:gone.messy.fixture -all a"),
        "_dmarc.messy.fixture|TXT": txt("_dmarc.messy.fixture", "v=DMARC1; p=reject; pct=50; adkim=x; rua=https://reports.messy.fixture/"),
        "selector1._domainkey.messy.fixture|TXT": txt("selector1._domainkey.messy.fixture", `${dkim(2048)}; t=y`),
        "selector2._domainkey.messy.fixture|TXT": txt("selector2._domainkey.messy.fixture", "v=DKIM1; p="),
        "_smtp._tls.messy.fixture|TXT": txt("_smtp._tls.messy.fixture", "v=TLSRPTv1; rua=ftp://messy.fixture/"),
        "default._bimi.messy.fixture|TXT": txt("default._bimi.messy.fixture", "v=BIMI1; l=https://messy.fixture/logo.svg"),
    }),
};

// Files by URL, each mail domain’s MTA-STS policy and a BIMI logo, served by the tests’ `delegated` stub.
export const FILES: Record<string, string> = {
    ...Object.fromEntries(["clean", "lookups", "plusall", "twospf", "dmarcnone", "weakdkim", "cnamemx", "mtasts"].map((name) => [`https://mta-sts.${name}.fixture/.well-known/mta-sts.txt`, `version: STSv1\r\nmode: enforce\r\nmx: mx.${name}.fixture\r\nmax_age: 604800\r\n`])),
    "https://mta-sts.messy.fixture/.well-known/mta-sts.txt": "version: STSv1\nmode: testing\nmx: *.messy.fixture\nmax_age: 3600\n",
    "https://messy.fixture/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" version="1.1"><script>alert(1)</script><image href="https://elsewhere.fixture/x.png"/></svg>',
};

// Adds or replaces one `name|TYPE` entry, for a record naming a port only known at run time.
export function setZone(key: string, zone: Zone): void {
    ZONES[key] = zone;
}

// The reply to one query, from the zone table; an unknown name is NOERROR with no answers.
function answer(query: Packet, isTcp: boolean, isValidating: boolean, overrides: Record<string, Zone>): Buffer {
    const question = query.questions?.[0];
    const key = `${question?.name || "."}|${question?.type}`;
    const zone = overrides[key] ?? ZONES[key] ?? MAIL_ZONES[key] ?? {};
    const isDirect = ((query.flags ?? 0) & dnsPacket.RECURSION_DESIRED) === 0;
    const isChecked = ((query.flags ?? 0) & dnsPacket.CHECKING_DISABLED) === 0;
    const isBogus = zone.bogus === true && isValidating && isChecked;
    const isTruncated = zone.truncate === true && !isTcp;
    const isReferral = isDirect && zone.referral !== undefined;
    const flags =
        (isBogus || zone.rcode === "SERVFAIL" ? 2 : zone.rcode === "NXDOMAIN" ? 3 : 0) |
        (isValidating && zone.ad ? dnsPacket.AUTHENTIC_DATA : 0) |
        (isDirect && zone.authoritative ? dnsPacket.AUTHORITATIVE_ANSWER : 0) |
        (!isDirect && zone.recursive ? dnsPacket.RECURSION_AVAILABLE : 0) |
        (isTruncated ? dnsPacket.TRUNCATED_RESPONSE : 0) |
        dnsPacket.RECURSION_DESIRED;
    return dnsPacket.encode({ type: "response", id: query.id, flags, questions: query.questions, answers: isBogus || isTruncated || isReferral ? [] : (zone.answers ?? []), ...(isReferral && { authorities: zone.referral }) } as Packet);
}

// A resolver answering the fixture zones over UDP and TCP on one ephemeral port; `isValidating` sets `AD` where signed.
export async function serveDns(isValidating = true, overrides: Record<string, Zone> = {}): Promise<DnsFixture> {
    const queries: string[] = [];
    const udp = createSocket("udp4");
    udp.on("message", (message, peer) => {
        const query = dnsPacket.decode(message);
        queries.push(`${query.questions?.[0]?.name}|${query.questions?.[0]?.type}`);
        udp.send(answer(query, false, isValidating, overrides), peer.port, peer.address);
    });
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const { port } = udp.address();
    const tcp = createServer((socket) => {
        socket.once("data", (chunk: Buffer) => {
            const reply = answer(dnsPacket.decode(chunk.subarray(2)), true, isValidating, overrides);
            const prefix = Buffer.alloc(2);
            prefix.writeUInt16BE(reply.length);
            socket.end(Buffer.concat([prefix, reply]));
        });
    });
    await new Promise<void>((resolve) => tcp.listen(port, "127.0.0.1", resolve));
    return {
        server: `127.0.0.1:${port}`,
        port: (tcp.address() as AddressInfo).port,
        queries,
        close: async () => {
            udp.close();
            await new Promise<void>((resolve) => tcp.close(() => resolve()));
        },
    };
}
