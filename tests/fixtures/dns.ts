// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

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
    "good.fixture|UNKNOWN_65": { answers: [{ type: "UNKNOWN_65", name: "good.fixture", ttl: 300, data: svcb(1, ".", [[1, alpn("h2", "h3")], [4, Buffer.from([192, 0, 2, 1])], [6, Buffer.from("20010db8000000000000000000000001", "hex")]]) } as unknown as Answer] },
    "good.fixture|CAA": { answers: [{ type: "CAA", name: "good.fixture", ttl: 300, data: { flags: 0, tag: "issue", value: "letsencrypt.org" } }, { type: "CAA", name: "good.fixture", ttl: 300, data: { flags: 0, tag: "iodef", value: "mailto:caa@good.fixture" } }] },
    "good.fixture|DS": { answers: [{ type: "DS", name: "good.fixture", ttl: 300, data: { keyTag: 1, algorithm: 13, digestType: 2, digest: Buffer.alloc(32) } }] },
    "good.fixture|DNSKEY": { answers: [{ type: "DNSKEY", name: "good.fixture", ttl: 300, data: { flags: 257, algorithm: 13, key: Buffer.alloc(64) } }] },
    "good.fixture|NSEC3PARAM": { answers: [{ type: "NSEC3PARAM", name: "good.fixture", ttl: 300, data: Buffer.from([1, 0, 0, 0, 0]) } as unknown as Answer] },
    "good.fixture|NS": { answers: [{ type: "NS", name: "good.fixture", ttl: 300, data: "ns1.good.fixture" }, { type: "NS", name: "good.fixture", ttl: 300, data: "ns2.good.fixture" }] },
    "ns1.good.fixture|A": { answers: [{ type: "A", name: "ns1.good.fixture", ttl: 300, data: "127.0.0.1" }] },
    "ns2.good.fixture|AAAA": { answers: [{ type: "AAAA", name: "ns2.good.fixture", ttl: 300, data: "::1" }] },
    "ns2.good.fixture|A": { answers: [{ type: "A", name: "ns2.good.fixture", ttl: 300, data: "127.0.0.1" }] },
    "big.good.fixture|A": { truncate: true, answers: [{ type: "A", name: "big.good.fixture", ttl: 300, data: "192.0.2.9" }] },
    "bad.fixture|SOA": { answers: [soa("bad.fixture", 3, 3600)] },
    "www.bad.fixture|A": { answers: [{ type: "CNAME", name: "www.bad.fixture", ttl: 300, data: "a.bad.fixture" }, { type: "CNAME", name: "a.bad.fixture", ttl: 300, data: "b.bad.fixture" }, { type: "CNAME", name: "b.bad.fixture", ttl: 300, data: "c.bad.fixture" }, { type: "A", name: "c.bad.fixture", ttl: 300, data: "198.51.100.1" }, rrsig("c.bad.fixture", SOON)] },
    "bad.fixture|DS": { answers: [{ type: "DS", name: "bad.fixture", ttl: 300, data: { keyTag: 2, algorithm: 5, digestType: 1, digest: Buffer.alloc(20) } }] },
    "bad.fixture|DNSKEY": { answers: [{ type: "DNSKEY", name: "bad.fixture", ttl: 300, data: { flags: 257, algorithm: 5, key: Buffer.alloc(64) } }] },
    "bad.fixture|NSEC3PARAM": { answers: [{ type: "NSEC3PARAM", name: "bad.fixture", ttl: 300, data: Buffer.from([1, 0, 0, 10, 4, 1, 2, 3, 4]) } as unknown as Answer] },
    "bad.fixture|NS": { answers: [{ type: "NS", name: "bad.fixture", ttl: 300, data: "ns1.bad.fixture" }], referral: [{ type: "NS", name: "bad.fixture", ttl: 172_800, data: "ns1.bad.fixture" }, { type: "NS", name: "bad.fixture", ttl: 172_800, data: "ns.old-host.fixture" }] },
    "ns1.bad.fixture|A": { answers: [{ type: "A", name: "ns1.bad.fixture", ttl: 300, data: "127.0.0.1" }] },
    "old.bad.fixture|A": { rcode: "NXDOMAIN", answers: [{ type: "CNAME", name: "old.bad.fixture", ttl: 300, data: "gone.elsewhere.fixture" }] },
    "quiet.fixture|SOA": { answers: [soa("quiet.fixture", 1)] },
    "quiet.fixture|MX": { answers: [{ type: "MX", name: "quiet.fixture", ttl: 300, data: { preference: 0, exchange: "." } }] },
    "quiet.fixture|TXT": { answers: [{ type: "TXT", name: "quiet.fixture", ttl: 300, data: ["v=spf1", " -all"] }, { type: "TXT", name: "quiet.fixture", ttl: 300, data: ["site-verification=1"] }] },
    "_dmarc.quiet.fixture|TXT": { answers: [{ type: "TXT", name: "_dmarc.quiet.fixture", ttl: 300, data: ["v=DMARC1; p=reject"] }] },
    "_for-sale.quiet.fixture|TXT": { answers: [{ type: "TXT", name: "_for-sale.quiet.fixture", ttl: 300, data: ["v=FORSALE1;fcod=XX-NGYyYjEyZWY"] }] },
    "_agents.quiet.fixture|UNKNOWN_64": { answers: [{ type: "UNKNOWN_64", name: "_agents.quiet.fixture", ttl: 300, data: svcb(1, "agents.quiet.fixture", [[1, alpn("h2")]]) } as unknown as Answer] },
    "www.bad.fixture|MX": { answers: [{ type: "MX", name: "www.bad.fixture", ttl: 300, data: { preference: 10, exchange: "mail.bad.fixture" } }] },
    "www.bad.fixture|TXT": { answers: [{ type: "TXT", name: "www.bad.fixture", ttl: 300, data: ["v=spf1 include:mail.bad.fixture ~all"] }] },
    "_dmarc.bad.fixture|TXT": { answers: [{ type: "TXT", name: "_dmarc.bad.fixture", ttl: 300, data: ["v=DMARC1; p=reject; sp=none"] }] },
    "mixed.fixture|SOA": { answers: [soa("mixed.fixture", 1)] },
    "mixed.fixture|MX": { answers: [{ type: "MX", name: "mixed.fixture", ttl: 300, data: { preference: 10, exchange: "mx.mixed.fixture" } }, { type: "MX", name: "mixed.fixture", ttl: 300, data: { preference: 0, exchange: "." } }] },
    "mixed.fixture|TXT": { answers: [{ type: "TXT", name: "mixed.fixture", ttl: 300, data: ["v=spf1 mx ?all"] }, { type: "TXT", name: "mixed.fixture", ttl: 300, data: ["v=spf1 -all"] }] },
    "only.fixture|A": { answers: [{ type: "A", name: "only.fixture", ttl: 300, data: "127.0.0.1" }] },
    "bogus.fixture|SOA": { answers: [soa("bogus.fixture", 1)] },
    "bogus.fixture|DS": { answers: [{ type: "DS", name: "bogus.fixture", ttl: 300, data: { keyTag: 3, algorithm: 13, digestType: 2, digest: Buffer.alloc(32) } }] },
    "bogus.fixture|A": { bogus: true, answers: [{ type: "A", name: "bogus.fixture", ttl: 300, data: "192.0.2.3" }] },
};

// Adds or replaces one `name|TYPE` entry, for a record naming a port only known at run time.
export function setZone(key: string, zone: Zone): void {
    ZONES[key] = zone;
}

// The reply to one query, from the zone table; an unknown name is NOERROR with no answers.
function answer(query: Packet, isTcp: boolean, isValidating: boolean, overrides: Record<string, Zone>): Buffer {
    const question = query.questions?.[0];
    const key = `${question?.name || "."}|${question?.type}`;
    const zone = overrides[key] ?? ZONES[key] ?? {};
    const isDirect = ((query.flags ?? 0) & dnsPacket.RECURSION_DESIRED) === 0;
    const isChecked = ((query.flags ?? 0) & dnsPacket.CHECKING_DISABLED) === 0;
    const isBogus = zone.bogus === true && isValidating && isChecked;
    const isTruncated = zone.truncate === true && !isTcp;
    const isReferral = isDirect && zone.referral !== undefined;
    const flags = (isBogus || zone.rcode === "SERVFAIL" ? 2 : zone.rcode === "NXDOMAIN" ? 3 : 0) | (isValidating && zone.ad ? dnsPacket.AUTHENTIC_DATA : 0) | (isDirect && zone.authoritative ? dnsPacket.AUTHORITATIVE_ANSWER : 0) | (!isDirect && zone.recursive ? dnsPacket.RECURSION_AVAILABLE : 0) | (isTruncated ? dnsPacket.TRUNCATED_RESPONSE : 0) | dnsPacket.RECURSION_DESIRED;
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
