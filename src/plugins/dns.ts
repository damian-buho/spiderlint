// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { Answer, CaaData, DnskeyData, DsData, RrsigData, SoaData } from "dns-packet";
import { getDomain } from "tldts";
import type { DnsClient, Reply } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { parseSvcb, type Svcb } from "../crawl/svcb.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

// Linked hosts under the zone checked for a dangling CNAME, at most.
const MAX_LINKED = 32;

// Suffixes of special-use names, never queried.
const SPECIAL_USE = ["localhost", "test", "invalid", "example", "local", "onion", "i2p", "alt", "internal", "home.arpa"];

// RFC 8624 §3.1: DNSKEY algorithms that MUST NOT sign, and DS digests that MUST NOT be used.
const WEAK_ALGORITHMS = [1, 3, 5, 6, 7, 12];
const WEAK_DIGESTS = [1, 3];

// Certificate issuer organisation to the CAA `issue` domains its CA honours.
const ISSUERS: [RegExp, string[]][] = [
    [/let.s encrypt/i, ["letsencrypt.org"]],
    [/actalis/i, ["actalis.it"]],
    [/google trust services/i, ["pki.goog"]],
    [/digicert/i, ["digicert.com", "symantec.com", "geotrust.com", "rapidssl.com", "thawte.com"]],
    [/sectigo|comodo|zerossl|usertrust/i, ["sectigo.com", "comodoca.com", "comodo.com", "usertrust.com", "trust-provider.com"]],
    [/globalsign/i, ["globalsign.com"]],
    [/amazon/i, ["amazon.com", "amazontrust.com", "awstrust.com", "amazonaws.com"]],
    [/buypass/i, ["buypass.com", "buypass.no"]],
    [/ssl\.com/i, ["ssl.com"]],
    [/entrust/i, ["entrust.net"]],
    [/harica/i, ["harica.gr"]],
    [/certum|asseco/i, ["certum.pl"]],
];

type Data<T> = Answer & { data: T; ttl?: number };

// The answers of `type`, in wire order.
function records<T>(reply: Reply, type: string): Data<T>[] {
    return reply.answers.filter((answer) => answer.type === type) as Data<T>[];
}

function isSameName(a: string, b: string): boolean {
    return a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");
}

// `name` and each parent up to `apex`, nearest first.
function climb(name: string, apex: string): string[] {
    const labels = name.split(".");
    return labels.map((_, index) => labels.slice(index).join(".")).slice(0, labels.length - apex.split(".").length + 1);
}

// Whether `host` is a special-use or overlay name the public DNS never answers (RFC 6761, 6762, 7686, 8375, 9476, ICANN `internal`, I2P).
export function isSpecialUse(host: string): boolean {
    const name = host.toLowerCase().replace(/\.$/, "");
    return SPECIAL_USE.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

// The first name from `host` up to its registrable domain that answers SOA; none for an IP, a special-use name or a public suffix.
async function zoneOf(host: string, dns: DnsClient): Promise<string | undefined> {
    const domain = isIP(host) === 0 && !isSpecialUse(host) ? getDomain(host, { allowPrivateDomains: true }) : undefined;
    if (!domain) {
        log.debug({ host }, "dns skipped, no registrable domain");
        return;
    }
    for (const name of climb(host, domain)) {
        const reply = await dns.query(name, "SOA");
        if (records<SoaData>(reply, "SOA").some((answer) => isSameName(answer.name, name))) return name;
    }
    log.debug({ host, domain }, "no SOA below the registrable domain, using it as the zone");
    return domain;
}

// Every hostname the subject’s pages link or load under `zone`, the subject aside.
function linkedHosts(host: string, zone: string, pages: readonly Facts[]): string[] {
    const urls = pages.flatMap((page) => [...(page.html?.links.internal ?? []), ...(page.html?.links.external ?? []), ...(page.resources ?? []).map((resource) => resource.url)]);
    const hosts = new Set(urls.flatMap((url) => (URL.canParse(url) ? [new URL(url).hostname] : [])).filter((name) => name !== host && (name === zone || name.endsWith(`.${zone}`))));
    log.debug({ host, zone, linked: hosts.size }, "linked hosts under the zone");
    return [...hosts].slice(0, MAX_LINKED);
}

// A linked name whose CNAME chain ends in NXDOMAIN, with the target that no longer exists.
async function dangling(name: string, dns: DnsClient): Promise<{ name: string; target: string } | undefined> {
    const reply = await dns.query(name, "A");
    const target = records<string>(reply, "CNAME").at(-1)?.data;
    log.debug({ name, rcode: reply.rcode, target }, "linked host resolved");
    return target && reply.rcode === "NXDOMAIN" ? { name, target } : undefined;
}

// The CAA set of the nearest name from `host` up to the registrable domain that has one (RFC 8659 §3).
async function caa(host: string, zone: string, dns: DnsClient): Promise<{ at: string; records: { flags: number; tag: string; value: string }[] } | undefined> {
    const names = climb(host, getDomain(zone, { allowPrivateDomains: true }) ?? zone);
    for (const name of names) {
        const reply = await dns.query(name, "CAA");
        const found = records<CaaData>(reply, "CAA");
        if (found.length > 0) return { at: name, records: found.map(({ data }) => ({ flags: data.flags ?? 0, tag: data.tag, value: data.value })) };
    }
    log.debug({ host }, "no CAA record found");
}

// Whether the CA that issued the served certificate may issue for this name; an unknown issuer is no fact.
function issuer(host: string, found: NonNullable<Awaited<ReturnType<typeof caa>>>, pages: readonly Facts[]): { name: string; domains: string[]; allowed: boolean } | undefined {
    const cert = pages.find((page) => page.tls?.cert.issuer)?.tls?.cert;
    const name = cert?.issuer;
    if (!name) return;
    const domains = ISSUERS.find(([pattern]) => pattern.test(name))?.[1];
    if (!domains) {
        log.debug({ host, issuer: name }, "certificate issuer has no known CAA domain; dns/caa-issuer skipped");
        return;
    }
    const wildcard = cert.san.some((entry) => entry.startsWith("*.")) && found.records.some((record) => record.tag === "issuewild");
    const issues = found.records.filter((record) => record.tag === (wildcard ? "issuewild" : "issue")).map((record) => record.value.split(";", 1)[0]?.trim().toLowerCase() ?? "");
    return { name, domains, allowed: issues.length === 0 || issues.some((domain) => domains.includes(domain)) };
}

// Whether any page on the host advertises `h3` in `Alt-Svc`.
function hasAltSvcH3(pages: readonly Facts[]): boolean {
    return pages.some((page) => [page.http.headers["alt-svc"] ?? []].flat().some((value) => /(^|,)\s*h3(-\d+)?=/.test(value)));
}

function isSameSet(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((entry) => b.includes(entry));
}

// Addresses, CNAME chain, HTTPS records, CAA and dangling linked names of one host.
const addresses: SiteExtractor = {
    id: "dns",
    per: "host",
    cached: false,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [a, aaaa, https] = await Promise.all([context.dns.query(host, "A"), context.dns.query(host, "AAAA"), context.dns.query(host, "UNKNOWN_65")]);
        const v4 = records<string>(a, "A").map(({ data, ttl }) => ({ address: data, ttl }));
        const v6 = records<string>(aaaa, "AAAA").map(({ data, ttl }) => ({ address: data, ttl }));
        const services = records<Buffer>(https, "UNKNOWN_65").flatMap(({ data }): (Svcb & { hintsMatch?: boolean })[] => {
            try {
                const record: Svcb & { hintsMatch?: boolean } = parseSvcb(data);
                const isHinted = record.ipv4hint !== undefined || record.ipv6hint !== undefined;
                if (isHinted && (record.target === "." || isSameName(record.target, host))) record.hintsMatch = isSameSet(record.ipv4hint ?? [], v4.map((entry) => entry.address)) && isSameSet(record.ipv6hint ?? [], v6.map((entry) => entry.address));
                return [record];
            } catch (error) {
                log.warn({ host, error: reason(error) }, "HTTPS record unparsable");
                return [];
            }
        });
        const authorised = await caa(host, zone, context.dns);
        const allowed = authorised && issuer(host, authorised, context.pages);
        const linked = await Promise.all(linkedHosts(host, zone, context.pages).map((name) => dangling(name, context.dns)));
        const broken = linked.filter((entry) => entry !== undefined);
        log.debug({ host, zone, a: v4.length, aaaa: v6.length, https: services.length, caa: authorised?.at, dangling: broken.length }, "dns records read");
        return {
            zone,
            a: v4,
            aaaa: v6,
            cname: records<string>(a, "CNAME").map(({ name, data, ttl }) => ({ name, target: data, ttl })),
            https: services,
            ...(services.some((record) => record.priority > 0) && { h3: { record: services.some((record) => record.alpn?.includes("h3")), altSvc: hasAltSvcH3(context.pages) } }),
            ...(authorised && { caa: { ...authorised, ...(allowed && { issuer: allowed }) } }),
            dangling: broken,
        };
    },
};

// NSEC3PARAM RDATA: algorithm, flags, iterations, salt length.
function nsec3(reply: Reply): { iterations: number; saltLength: number } | undefined {
    const data = records<Buffer>(reply, "NSEC3PARAM")[0]?.data;
    return data && data.length >= 5 ? { iterations: data.readUInt16BE(2), saltLength: data.readUInt8(4) } : undefined;
}

// Whether a signed host fails validation: the resolver answers SERVFAIL and a checking-disabled retry answers.
async function bogus(host: string, a: Reply, context: SiteContext): Promise<boolean | undefined> {
    if (!(await context.dns.validating())) return;
    if (a.rcode !== "SERVFAIL") return false;
    const unchecked = await context.dns.query(host, "A", { checkingDisabled: true });
    log.debug({ host, rcode: unchecked.rcode }, "checking-disabled retry answered");
    return unchecked.rcode === "NOERROR";
}

// DS at the parent, DNSKEY, the resolver’s `AD`, the soonest RRSIG expiry and NSEC3 parameters of the host’s zone.
const dnssec: SiteExtractor = {
    id: "dnssec",
    per: "host",
    cached: false,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [ds, dnskey, a, parameters] = await Promise.all([context.dns.query(zone, "DS"), context.dns.query(zone, "DNSKEY"), context.dns.query(host, "A"), context.dns.query(zone, "NSEC3PARAM")]);
        const delegation = records<DsData>(ds, "DS").map(({ data }) => ({ keyTag: data.keyTag, algorithm: data.algorithm, digestType: data.digestType }));
        const keys = records<DnskeyData>(dnskey, "DNSKEY").map(({ data }) => ({ algorithm: data.algorithm, flags: data.flags }));
        const soonest = records<RrsigData>(a, "RRSIG").toSorted((x, y) => x.data.expiration - y.data.expiration)[0]?.data;
        const isSigned = delegation.length > 0;
        const failed = isSigned ? await bogus(host, a, context) : false;
        log.debug({ host, zone, ds: delegation.length, dnskey: keys.length, ad: a.ad, rcode: a.rcode, bogus: failed }, "dnssec read");
        return {
            zone,
            signed: isSigned,
            ds: delegation,
            dnskey: keys,
            ad: a.ad,
            ...(failed !== undefined && { bogus: failed }),
            ...(soonest && { rrsig: { expires: new Date(soonest.expiration * 1000).toISOString(), daysLeft: Math.floor((soonest.expiration * 1000 - Date.now()) / 86_400_000), left: Math.round(((soonest.expiration * 1000 - Date.now()) / ((soonest.expiration - soonest.inception) * 1000)) * 100) / 100 } }),
            ...(nsec3(parameters) && { nsec3: nsec3(parameters) }),
        };
    },
};

// The first three groups of an IPv6 address, or octets of an IPv4 one: its /48 or /24.
function network(address: string): string {
    if (isIP(address) === 4) return address.split(".").slice(0, 3).join(".");
    const [head = "", tail = ""] = address.split("::", 2);
    const [left, right] = [head ? head.split(":") : [], tail ? tail.split(":") : []];
    const groups = address.includes("::") ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right] : left;
    return groups.slice(0, 3).map((group) => Number.parseInt(group, 16).toString(16)).join(":");
}

// One name server: its addresses, and its own SOA answer when asked directly, IPv4 first.
async function nameServer(zone: string, name: string, dns: DnsClient): Promise<{ name: string; addresses: string[]; soaSerial?: number; authoritative?: boolean }> {
    const [a, aaaa] = await Promise.all([dns.query(name, "A"), dns.query(name, "AAAA")]);
    const addresses = [...records<string>(a, "A"), ...records<string>(aaaa, "AAAA")].map(({ data }) => data);
    if (!dns.canQueryDirectly) return { name, addresses };
    for (const address of addresses) {
        try {
            const reply = await dns.query(zone, "SOA", { server: address });
            const serial = records<SoaData>(reply, "SOA")[0]?.data.serial;
            log.debug({ zone, name, address, aa: reply.aa, serial }, "name server asked directly");
            return { name, addresses, ...(serial !== undefined && { soaSerial: serial }), authoritative: reply.aa && serial !== undefined };
        } catch (error) {
            log.debug({ zone, name, address, error: reason(error) }, "name server unreachable");
        }
    }
    return { name, addresses, authoritative: false };
}

// The zone’s NS set, each asked directly for the SOA serial, and how many networks their addresses span.
const nameservers: SiteExtractor = {
    id: "nameservers",
    per: "host",
    cached: false,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const names = records<string>(await context.dns.query(zone, "NS"), "NS").map(({ data }) => data);
        const servers = await Promise.all(names.map((name) => nameServer(zone, name, context.dns)));
        const serials = [...new Set(servers.flatMap((server) => (server.soaSerial === undefined ? [] : [server.soaSerial])))];
        const networks = new Set(servers.flatMap((server) => server.addresses.map((address) => network(address)))).size;
        log.debug({ host, zone, servers: names.length, serials, networks }, "name servers read");
        return { zone, servers, networks, ...(context.dns.canQueryDirectly && { serials }) };
    },
};

const RULES: Record<string, RuleSpec> = {
    "dns/https-record": {
        fact: "site.hosts.*.dns.https",
        expect: { minItems: 1 },
        message: "no HTTPS record, so a first visit learns h3 and ECH only from Alt-Svc, one connection late",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460",
    },
    "dns/https-alpn": {
        fact: "site.hosts.*.dns.h3",
        expect: { anyOf: [{ properties: { record: { const: true }, altSvc: { const: true } } }, { properties: { record: { const: false }, altSvc: { const: false } } }] },
        message: "the HTTPS record and Alt-Svc disagree about h3 (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.1",
    },
    "dns/https-hints": {
        fact: "site.hosts.*.dns.https",
        expect: { items: { properties: { hintsMatch: { const: true } } } },
        message: "ipv4hint or ipv6hint does not match the A and AAAA records",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.3",
    },
    "dns/caa": {
        fact: "site.hosts.*.dns.caa",
        expect: { type: "object" },
        message: "no CAA record on the host or any parent, so any CA may issue for it",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8659",
    },
    "dns/caa-issuer": {
        fact: "site.hosts.*.dns.caa.issuer",
        expect: { properties: { allowed: { const: true } } },
        when: { "site.hosts.*.dns.caa.issuer": { type: "object" } },
        message: "CAA does not allow the CA that issued the served certificate (got {got})",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.2",
    },
    "dns/caa-iodef": {
        fact: "site.hosts.*.dns.caa.records",
        expect: { contains: { properties: { tag: { const: "iodef" } } } },
        when: { "site.hosts.*.dns.caa": { type: "object" } },
        message: "CAA names no iodef address for refused issuance reports",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.4",
    },
    "dns/aaaa": {
        fact: "site.hosts.*.dns.aaaa",
        expect: { minItems: 1 },
        message: "no AAAA record, so the host is unreachable over IPv6",
        severity: "info",
    },
    "dns/cname-chain": {
        fact: "site.hosts.*.dns.cname",
        expect: { maxItems: 2 },
        message: "the name resolves through {got} of CNAME hops",
        severity: "info",
    },
    "dns/dangling-cname": {
        fact: "site.hosts.*.dns.dangling",
        expect: { maxItems: 0 },
        message: "a linked name under the zone is a CNAME to a name that does not exist, open to takeover (got {got})",
        severity: "error",
        docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Subdomain_takeovers",
    },
    "dns/dnssec": {
        fact: "site.hosts.*.dnssec.signed",
        expect: { const: true },
        message: "the zone is not signed with DNSSEC",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc9364",
    },
    "dns/dnssec-bogus": {
        fact: "site.hosts.*.dnssec.bogus",
        expect: { const: false },
        when: { "site.hosts.*.dnssec.bogus": { type: "boolean" } },
        message: "the zone is signed but fails validation, so every validating resolver answers SERVFAIL",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-5.5",
    },
    "dns/dnssec-algorithm": {
        fact: "site.hosts.*.dnssec",
        expect: { properties: { ds: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } }, digestType: { not: { enum: WEAK_DIGESTS } } } } }, dnskey: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } } } } } } },
        when: { "site.hosts.*.dnssec.signed": true },
        message: "the zone signs or digests with an algorithm RFC 8624 forbids",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8624#section-3.1",
    },
    "dns/rrsig-expiry": {
        fact: "site.hosts.*.dnssec.rrsig",
        expect: { properties: { left: { minimum: 0.25 } } },
        when: { "site.hosts.*.dnssec.rrsig": { type: "object" } },
        message: "less than a quarter of the host’s signature validity is left, so re-signing has stalled (got {got})",
        severity: "warning",
    },
    "dns/nsec3-iterations": {
        fact: "site.hosts.*.dnssec.nsec3",
        expect: { properties: { iterations: { const: 0 }, saltLength: { const: 0 } } },
        when: { "site.hosts.*.dnssec.nsec3": { type: "object" } },
        message: "NSEC3 uses extra iterations or a salt (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9276#section-3.1",
    },
    "dns/ns-count": {
        fact: "site.hosts.*.nameservers.servers",
        expect: { minItems: 2 },
        message: "the zone has {got} name servers, fewer than 2",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.1",
    },
    "dns/ns-consistent": {
        fact: "site.hosts.*.nameservers",
        expect: { properties: { servers: { items: { properties: { authoritative: { const: true } } } }, serials: { maxItems: 1 } } },
        when: { "site.hosts.*.nameservers.serials": { type: "array" } },
        message: "a name server is lame or the servers disagree on the SOA serial (got {got})",
        severity: "warning",
    },
    "dns/ns-diversity": {
        fact: "site.hosts.*.nameservers.networks",
        expect: { minimum: 2 },
        message: "every name server address sits in one /24 or /48",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc2182#section-3.1",
    },
};

const CORE = ["dns/https-record", "dns/caa", "dns/caa-issuer", "dns/dangling-cname", "dns/dnssec", "dns/dnssec-bogus"];

// Records, CAA, DNSSEC and name servers of every crawled host, asked of the configured resolver.
export default definePlugin({
    name: "dns",
    sites: [addresses, dnssec, nameservers],
    presets: {
        dns: { description: "DNS of every crawled host: HTTPS records, CAA, DNSSEC, name servers, dangling CNAMEs", rules: RULES },
        "dns:core": { description: "HTTPS record, CAA, DNSSEC state and dangling CNAMEs, a handful of queries per host", rules: Object.fromEntries(CORE.map((id) => [id, RULES[id] as RuleSpec])) },
    },
});
