// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { isIP } from "node:net";
import type { Answer, CaaData, DnskeyData, DsData, RrsigData, SoaData } from "dns-packet";
import { getDomain } from "tldts";
import { Bucket } from "../cache/index.ts";
import { dnsClient, parseResolver, type DnsClient, type Reply, type StoredReply } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { nsName, registration, type Registration } from "../crawl/rdap.ts";
import { parseSvcb, type Svcb } from "../crawl/svcb.ts";
import type { Facts } from "../facts/types.ts";
import { dnsProvider } from "../facts/vendors.ts";
import { log } from "../logger.ts";
import { recordFix } from "../rules/fix.ts";
import type { RuleSpec } from "../rules/types.ts";
import { type SiteContext, type SiteExtractor, type Plugin } from "./types.ts";

// Suffixes of special-use and overlay names (RFC 6761, 6762, 7686, 8375, 9476, ICANN `internal`, I2P, Tailscale `ts.net`), never queried against public DNS/RDAP/RPKI.
const SPECIAL_USE = ["localhost", "test", "invalid", "example", "local", "onion", "i2p", "alt", "internal", "home.arpa", "ts.net"];

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

// A name an open resolver answers and a server that only serves its own zones refuses or refers.
const UNRELATED = "a.root-servers.net";

// Parent servers asked for a delegation before giving up.
const PARENT_TRIES = 3;

// `org.spiderlint.dns`: public resolvers to compare the configured one with, none by default so no third party is asked; `rdap: false` never asks a registry.
export interface DnsSettings {
    compare: string[];
    rdap: boolean;
}

// Sources that already warned in a run, keyed by the run client’s `validating`, which every context’s copy shares.
const warned = new WeakMap<object, Set<string>>();

// Warns the first time `source` fails in a run, and logs every later failure at debug.
export function warnOnce(dns: DnsClient, source: string, fields: Record<string, unknown>): void {
    const seen = warned.get(dns.validating) ?? new Set<string>();
    warned.set(dns.validating, seen);
    if (seen.has(source)) return log.debug({ source, ...fields }, "lookup failed again");
    seen.add(source);
    log.warn({ source, ...fields }, `${source} unreachable; its facts skipped`);
}

// The value `make` yields for `key`, asked once per map.
export function once<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
    const known = cache.get(key) ?? make();
    cache.set(key, known);
    return known;
}

// The answers of `type`, in wire order.
export function records<T>(reply: Reply, type: string): Data<T>[] {
    return reply.answers.filter((answer) => answer.type === type) as Data<T>[];
}

// Each TXT record’s character-strings joined, as RFC 7208 §3.3 reads them.
export function texts(reply: Reply): string[] {
    return records<Buffer | Buffer[]>(reply, "TXT").map(({ data }) => (Array.isArray(data) ? data : [data]).map((chunk) => chunk.toString("utf8")).join(""));
}

// Parsed HTTPS-shaped records (`UNKNOWN_65`); an unparsable one warns and is dropped.
function services(host: string, reply: Reply): Svcb[] {
    return records<Buffer>(reply, "UNKNOWN_65").flatMap(({ data }) => {
        try {
            return [parseSvcb(data)];
        } catch (error) {
            log.warn({ host, type: "UNKNOWN_65", error: reason(error) }, `UNKNOWN_65 record of ${host} unparsable:`);
            return [];
        }
    });
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
export async function zoneOf(host: string, dns: DnsClient): Promise<string | undefined> {
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

// The last CNAME target of an A answer that ends in NXDOMAIN, a name open to takeover; `false` otherwise.
function dangling(host: string, reply: Reply): string | false {
    const target = records<string>(reply, "CNAME").at(-1)?.data;
    log.debug({ host, rcode: reply.rcode, target }, "cname chain resolved");
    return (reply.rcode === "NXDOMAIN" && target) || false;
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
        log.debug({ host, issuer: name }, "certificate issuer has no known CAA domain; dns/caa-issuer/mismatch skipped");
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
    resolves: true,
    async extract(host, context) {
        if (context.linked) {
            if (isIP(host) !== 0 || isSpecialUse(host)) return;
            const a = await context.dns.query(host, "A");
            return { cname: records<string>(a, "CNAME").map(({ name, data, ttl }) => ({ name, target: data, ttl })), dangling: dangling(host, a) };
        }
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [a, aaaa, https, sale, agents, apex] = await Promise.all([context.dns.query(host, "A"), context.dns.query(host, "AAAA"), context.dns.query(host, "UNKNOWN_65"), context.dns.query(`_for-sale.${zone}`, "TXT"), context.dns.query(`_index._agents.${zone}`, "UNKNOWN_65"), context.dns.query(zone, "CNAME")]);
        const v4 = records<string>(a, "A").map(({ data, ttl }) => ({ address: data, ttl }));
        const v6 = records<string>(aaaa, "AAAA").map(({ data, ttl }) => ({ address: data, ttl }));
        const hinted = services(host, https).map((record): Svcb & { "hints-match"?: boolean } => {
            const isHinted = record.ipv4hint !== undefined || record.ipv6hint !== undefined;
            return isHinted && (record.target === "." || isSameName(record.target, host))
                ? {
                      ...record,
                      "hints-match":
                          isSameSet(
                              record.ipv4hint ?? [],
                              v4.map((entry) => entry.address),
                          ) &&
                          isSameSet(
                              record.ipv6hint ?? [],
                              v6.map((entry) => entry.address),
                          ),
                  }
                : record;
        });
        const forSale = texts(sale);
        const agentServices = services(host, agents);
        const authorised = await caa(host, zone, context.dns);
        const allowed = authorised && issuer(host, authorised, context.pages);
        const broken = dangling(host, a);
        const apexAlias = records<string>(apex, "CNAME").find((record) => isSameName(record.name, zone))?.data ?? false;
        log.debug({ host, zone, apexCname: apexAlias, a: v4.length, aaaa: v6.length, https: hinted.length, caa: authorised?.at, dangling: broken, forSale: forSale.length, agents: agentServices.length }, "dns records read");
        return {
            zone,
            a: v4,
            aaaa: v6,
            cname: records<string>(a, "CNAME").map(({ name, data, ttl }) => ({ name, target: data, ttl })),
            https: hinted,
            ...(hinted.some((record) => record.priority > 0) && { h3: { record: hinted.some((record) => record.alpn?.includes("h3")), "alt-svc": hasAltSvcH3(context.pages) } }),
            ...(authorised && { caa: { ...authorised, ...(allowed && { issuer: allowed }) } }),
            dangling: broken,
            "apex-cname": apexAlias,
            ...(forSale.length > 0 && { "for-sale": forSale }),
            ...(agentServices.length > 0 && { agents: agentServices }),
        };
    },
};

// NSEC3PARAM RDATA: algorithm, flags, iterations, salt length.
function nsec3(reply: Reply): { iterations: number; "salt-length": number } | undefined {
    const data = records<Buffer>(reply, "NSEC3PARAM")[0]?.data;
    return data && data.length >= 5 ? { iterations: data.readUInt16BE(2), "salt-length": data.readUInt8(4) } : undefined;
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
    resolves: true,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [ds, dnskey, a, parameters] = await Promise.all([context.dns.query(zone, "DS"), context.dns.query(zone, "DNSKEY"), context.dns.query(host, "A"), context.dns.query(zone, "NSEC3PARAM")]);
        const delegation = records<DsData>(ds, "DS").map(({ data }) => ({ "key-tag": data.keyTag, algorithm: data.algorithm, "digest-type": data.digestType }));
        const keys = records<DnskeyData>(dnskey, "DNSKEY").map(({ data }) => ({ algorithm: data.algorithm, flags: data.flags }));
        const soonest = records<RrsigData>(a, "RRSIG").toSorted((x, y) => x.data.expiration - y.data.expiration)[0]?.data;
        const isSigned = delegation.length > 0;
        const failed = isSigned && (await bogus(host, a, context));
        log.debug({ host, zone, ds: delegation.length, dnskey: keys.length, ad: a.ad, rcode: a.rcode, bogus: failed }, "dnssec read");
        return {
            zone,
            signed: isSigned,
            ds: delegation,
            dnskey: keys,
            ad: a.ad,
            ...(failed !== undefined && { bogus: failed }),
            ...(soonest && { rrsig: { expires: new Date(soonest.expiration * 1000).toISOString(), "days-left": Math.floor((soonest.expiration * 1000 - Date.now()) / 86_400_000), left: Math.round(((soonest.expiration * 1000 - Date.now()) / ((soonest.expiration - soonest.inception) * 1000)) * 100) / 100 } }),
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
    return groups
        .slice(0, 3)
        .map((group) => Number.parseInt(group, 16).toString(16))
        .join(":");
}

// The host’s A, AAAA and CNAME answers as sorted `TYPE data` lines, so two servers’ answers compare as sets.
function answerSet(...replies: Reply[]): string[] {
    const lines = replies.flatMap((reply) => reply.answers.filter((answer) => ["A", "AAAA", "CNAME"].includes(answer.type)).map((answer) => `${answer.type} ${String((answer as Data<unknown>).data).toLowerCase()}`));
    return [...new Set(lines)].toSorted((a, b) => a.localeCompare(b));
}

// The host’s answer set from one server, asked as `options` says.
async function hostAnswers(host: string, dns: DnsClient, options: Parameters<DnsClient["query"]>[2] = {}): Promise<{ rcode: string; ad: boolean; answers: string[] }> {
    const [a, aaaa] = await Promise.all([dns.query(host, "A", options), dns.query(host, "AAAA", options)]);
    return { rcode: a.rcode, ad: a.ad, answers: answerSet(a, aaaa) };
}

// One name server: its addresses, its own SOA answer and the host’s records when asked directly, IPv4 first.
async function nameServer(zone: string, host: string, name: string, dns: DnsClient): Promise<{ name: string; addresses: string[]; "soa-serial"?: number; authoritative?: boolean; answers?: string[]; recursive?: boolean }> {
    const [a, aaaa] = await Promise.all([dns.query(name, "A"), dns.query(name, "AAAA")]);
    const addresses = [...records<string>(a, "A"), ...records<string>(aaaa, "AAAA")].map(({ data }) => data);
    if (!dns.canQueryDirectly) return { name, addresses };
    for (const address of addresses) {
        try {
            const reply = await dns.query(zone, "SOA", { server: address });
            const serial = records<SoaData>(reply, "SOA")[0]?.data.serial;
            const { answers } = await hostAnswers(host, dns, { server: address });
            const unrelated = await dns.query(UNRELATED, "A", { server: address, recursion: true });
            const isRecursive = unrelated.ra && unrelated.rcode === "NOERROR" && records<string>(unrelated, "A").length > 0;
            log.debug({ zone, host, name, address, aa: reply.aa, serial, answers, isRecursive }, "name server asked directly");
            return { name, addresses, ...(serial !== undefined && { "soa-serial": serial }), authoritative: reply.aa && serial !== undefined, answers, recursive: isRecursive };
        } catch (error) {
            log.debug({ zone, name, address, error: reason(error) }, "name server unreachable");
        }
    }
    return { name, addresses, authoritative: false };
}

// The NS set the parent zone delegates `zone` to, asked of a parent server directly; none when no parent server answers.
async function delegation(zone: string, dns: DnsClient): Promise<string[] | undefined> {
    const parent = zone.split(".").slice(1).join(".") || ".";
    const parents = records<string>(await dns.query(parent, "NS"), "NS").map(({ data }) => data);
    const resolved = await Promise.all(parents.map(async (name) => records<string>(await dns.query(name, "A"), "A").map(({ data }) => data)));
    const addresses = resolved.flat().slice(0, PARENT_TRIES);
    for (const address of addresses) {
        try {
            const reply = await dns.query(zone, "NS", { server: address });
            const names = [...reply.answers, ...reply.authorities].filter((record) => record.type === "NS" && isSameName(record.name, zone)).map((record) => nsName(String((record as Data<string>).data)));
            log.debug({ zone, parent, address, names }, "parent asked for the delegation");
            if (names.length > 0) return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
        } catch (error) {
            log.debug({ zone, parent, address, error: reason(error) }, "parent server unreachable");
        }
    }
    log.debug({ zone, parent, tried: addresses.length }, "no parent server named the delegation");
    return undefined;
}

// The zone SOA’s timers, whether retry stays below refresh, and whether MNAME is one of the NS.
async function soaOf(zone: string, names: string[], dns: DnsClient): Promise<Record<string, unknown> | undefined> {
    const data = records<SoaData>(await dns.query(zone, "SOA"), "SOA").find((record) => isSameName(record.name, zone))?.data;
    log.debug({ zone, soa: data }, "soa read");
    return data && { mname: nsName(data.mname), refresh: data.refresh, retry: data.retry, expire: data.expire, minimum: data.minimum, "retry-below-refresh": (data.retry ?? 0) < (data.refresh ?? 0), "mname-listed": names.some((name) => isSameName(name, data.mname)) };
}

// The smallest TTL per record type as `server` serves them, not as a resolver’s cache counts them down.
async function ttlsOf(zone: string, host: string, server: string, dns: DnsClient): Promise<Record<string, number>> {
    const asked: [string, string, string][] = [
        ["ns", zone, "NS"],
        ["a", host, "A"],
        ["aaaa", host, "AAAA"],
        ["mx", host, "MX"],
    ];
    const ttls = await Promise.all(asked.map(async ([key, name, type]) => [key, records<unknown>(await dns.query(name, type, { server }), type).map((record) => record.ttl ?? 0)] as const));
    log.debug({ zone, host, server, ttls }, "authoritative ttls read");
    return Object.fromEntries(ttls.flatMap(([key, found]) => (found.length > 0 ? [[key, Math.min(...found)]] : [])));
}

// The zone’s NS set, each asked directly for the SOA serial and the host’s records, and how many networks their addresses span.
const nameservers: SiteExtractor = {
    id: "nameservers",
    per: "host",
    cached: false,
    resolves: true,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const names = records<string>(await context.dns.query(zone, "NS"), "NS").map(({ data }) => data);
        const servers = await Promise.all(names.map((name) => nameServer(zone, host, name, context.dns)));
        const serials = [...new Set(servers.flatMap((server) => (server["soa-serial"] === undefined ? [] : [server["soa-serial"]])))];
        const networks = new Set(servers.flatMap((server) => server.addresses.map((address) => network(address)))).size;
        const sets = [...new Set(servers.flatMap((server) => (server.answers ? [JSON.stringify(server.answers)] : [])))];
        const view = context.dns.canQueryDirectly && sets.length > 0 ? await hostAnswers(host, context.dns) : undefined;
        const resolved = view?.answers;
        const agreement = resolved && { "answer-sets": sets.length, "resolver-agrees": sets.includes(JSON.stringify(resolved)), resolver: resolved };
        const own = names.map((name) => nsName(name)).toSorted((a, b) => a.localeCompare(b));
        const parent = context.dns.canQueryDirectly ? await delegation(zone, context.dns) : undefined;
        const lame = context.dns.canQueryDirectly ? servers.filter((server) => server.authoritative === false).map((server) => nsName(server.name)) : undefined;
        const gone = (parent ?? []).filter((name) => !own.includes(name)).map((name) => `${name} is delegated by the parent but not in the zone’s NS records`);
        const extra = own.filter((name) => parent && !parent.includes(name)).map((name) => `${name} is in the zone’s NS records but not delegated by the parent`);
        const differs = [...gone, ...extra];
        const disagreeing = sets.length > 1 ? servers.filter((server) => server.answers).map((server) => `${nsName(server.name)} answers ${server.answers?.join(", ") || "nothing"}`) : [];
        const primary = servers.find((server) => server.authoritative)?.addresses[0];
        const [soa, ttl] = await Promise.all([soaOf(zone, names, context.dns), primary ? ttlsOf(zone, host, primary, context.dns) : undefined]);
        const managed = own.length > 0 ? dnsProvider(own) : undefined;
        const provider = managed && { name: managed.provider, ...(managed["soa-editable"] !== undefined && { "soa-editable": managed["soa-editable"] }), docs: managed.docs };
        log.debug({ host, zone, servers: names.length, serials, networks, sets: sets.length, resolverAgrees: agreement?.["resolver-agrees"], delegation: parent, primary, provider: provider?.name }, "name servers read");
        return {
            zone,
            servers,
            networks,
            ...(context.dns.canQueryDirectly && { serials }),
            ...(lame && { lame }),
            ...agreement,
            ...(sets.length > 0 && { differing: disagreeing }),
            ...(parent && { delegation: { servers: parent, matches: isSameSet(parent, own), differs } }),
            ...(soa && { soa }),
            ...(ttl && { ttl }),
            ...(provider && { provider }),
        };
    },
};

// The host as each compared public resolver answers it, beside the configured one; runs only when `compare` names servers.
const resolvers: SiteExtractor = {
    id: "resolvers",
    per: "host",
    cached: false,
    resolves: true,
    async extract(host, context) {
        const { compare = [] } = (context.settings ?? {}) as Partial<DnsSettings>;
        const isAsked = compare.length > 0 && context.dns.canQueryDirectly && isIP(host) === 0 && !isSpecialUse(host);
        log.debug({ host, compare, canQueryDirectly: context.dns.canQueryDirectly, isAsked }, "resolver comparison decided");
        if (!isAsked) return;
        const off = new Bucket<StoredReply>("dns", undefined, 60, "off");
        const clients: [string, DnsClient][] = [["configured", context.dns], ...compare.map((server): [string, DnsClient] => [server, dnsClient(parseResolver(server), off, false)])];
        const views = await Promise.all(
            clients.map(async ([server, client]) => {
                try {
                    return { server, ...(await hostAnswers(host, client, { signal: context.signal })) };
                } catch (error) {
                    log.debug({ host, server, error: reason(error) }, "compared resolver unreachable");
                    return { server, rcode: "NO ANSWER", ad: false, answers: [] };
                }
            }),
        );
        const rcodes = [...new Set(views.map((view) => view.rcode))];
        const sets = new Set(views.filter((view) => view.rcode === "NOERROR").map((view) => JSON.stringify(view.answers))).size;
        const validation = [...new Set(views.filter((view) => view.rcode === "NOERROR").map((view) => view.ad))];
        log.debug({ host, servers: views.length, rcodes, sets, validation }, "resolvers compared");
        return { servers: views, rcodes, "answer-sets": sets, validated: validation };
    },
};

// Registrations already asked for in a run, keyed as `warned` is.
const registrations = new WeakMap<object, Map<string, Promise<Registration | undefined>>>();

// The host’s registrable domain as its registry records it over RDAP; skipped under a private suffix, whose owner registers nothing.
const rdap: SiteExtractor = {
    id: "rdap",
    per: "host",
    resolves: true,
    async extract(host, context) {
        const { rdap: isAsked = true } = (context.settings ?? {}) as Partial<DnsSettings>;
        const domain = isIP(host) === 0 && !isSpecialUse(host) ? getDomain(host) : undefined;
        const isRegistered = domain !== null && domain !== undefined && getDomain(host, { allowPrivateDomains: true }) === domain;
        log.debug({ host, domain, isAsked, isRegistered }, "rdap lookup decided");
        if (!isAsked || !isRegistered) return;
        const asked = registrations.get(context.dns.validating) ?? new Map<string, Promise<Registration | undefined>>();
        registrations.set(context.dns.validating, asked);
        let found: Registration | undefined;
        try {
            found = await once(asked, domain, () => registration(domain, context.delegated));
        } catch (error) {
            warnOnce(context.dns, "RDAP", { host, domain, error: reason(error) });
            return;
        }
        if (!found) return;
        const zoned = records<string>(await context.dns.query(domain, "NS"), "NS")
            .map(({ data }) => nsName(data))
            .toSorted((a, b) => a.localeCompare(b));
        const daysLeft = found.expires === undefined ? undefined : Math.floor((Date.parse(found.expires) - Date.now()) / 86_400_000);
        log.debug({ host, domain, daysLeft, status: found.status, registry: found.nameservers, zone: zoned }, "registration read");
        return {
            domain,
            ...found,
            ...(daysLeft !== undefined && { "days-left": daysLeft }),
            ...(found.nameservers.length > 0 &&
                zoned.length > 0 && {
                    "ns-matches": isSameSet(found.nameservers, zoned),
                    "ns-differs": [
                        ...found.nameservers.filter((name) => !zoned.includes(name)).map((name) => `${name} is listed by the registry but not in the zone’s NS records`),
                        ...zoned.filter((name) => !found.nameservers.includes(name)).map((name) => `${name} is in the zone’s NS records but not listed by the registry`),
                    ],
                }),
        };
    },
};

// Guards a mail rule to the names judged as taking and sending no mail, or as mail names.
const SILENT = { "site.hosts.*.mail.mode": "none" };
const ACTIVE = { "site.hosts.*.mail.mode": "mail" };

const DMARC_QUARANTINE = { Name: "_dmarc.{domain}", Content: "v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain}" };
const DMARC_REJECT_LATER = "After a few weeks, read the reports sent to dmarc@{domain}. When every server they list is yours, change `p=quarantine` to `p=reject`.";

export const MAIL_RULES: Record<string, RuleSpec> = {
    "dns/null-mx/missing": {
        fact: "site.hosts.*.mail.mx",
        when: SILENT,
        expect: { minItems: 1, maxItems: 1, items: { properties: { preference: { const: 0 }, exchange: { const: "." } } } },
        message: "no null MX, so senders fall back to the name’s A or AAAA address and retry mail it never takes for days (got {got})",
        title: "A name that takes no mail has no null MX record",
        rationale: "Without a null MX, senders fall back to the name’s A or AAAA address and keep retrying mail it never accepts, for days. Checked only on names that appear to take and send no mail.",
        severity: "warning",
        score: 5.6,
        docs: "https://www.rfc-editor.org/rfc/rfc7505",
        fix: recordFix("Add an MX record that says the name takes no mail.", { Name: "{host}", "Mail server": ".", Priority: "0", "Zone file": "{host}. MX 0 ." }, "Then delete every other MX record of the name."),
    },
    "dns/spf-null/missing": {
        fact: "site.hosts.*.mail.spf",
        when: SILENT,
        expect: { minItems: 1, maxItems: 1, items: { pattern: String.raw`^[vV]=[sS][pP][fF]1\s+-[aA][lL][lL]\s*$` } },
        message: "SPF is not a lone v=spf1 -all, so receivers cannot refuse mail forged from this name (got {got})",
        title: "A name that sends no mail has no deny-all SPF record",
        rationale: "Without a lone SPF record of v=spf1 -all, receivers cannot refuse mail forged from this name, so anyone can impersonate it to phish recipients. Checked only on names that appear to take and send no mail.",
        severity: "warning",
        score: 6.1,
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.1",
        fix: recordFix("Add a TXT record that says no server sends mail as this name.", { Name: "{host}", Content: "v=spf1 -all" }, "Then delete every other TXT record of the name that starts with `v=spf1`. A subdomain does not inherit this record, so each name that sends no mail needs its own."),
    },
    "dns/dmarc-reject/missing": {
        fact: "site.hosts.*.mail.dmarc",
        when: SILENT,
        expect: { type: "object", required: ["policy"], properties: { policy: { const: "reject" } } },
        message: "no DMARC policy of reject applies to the name, so receivers accept mail forged from it (got {got})",
        title: "A name that sends no mail has no DMARC reject policy",
        rationale: "Without a DMARC policy of reject, receivers accept mail forged from the name, so phishers can borrow its reputation. Checked only on names that appear to take and send no mail.",
        severity: "warning",
        score: 6.4,
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: recordFix("Add a TXT record that tells receivers to refuse mail forged from `{domain}` or any name under it.", { Name: "_dmarc.{domain}", Content: "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s" }),
    },
    "dns/null-mx/invalid": {
        fact: "site.hosts.*.mail.mx",
        when: ACTIVE,
        expect: { items: { properties: { exchange: { not: { const: "." } } } } },
        message: "a null MX on a name that takes or sends mail, so senders may drop mail to it and receivers may refuse mail from it (got {got})",
        title: "A null MX sits on a name that takes or sends mail",
        rationale: "A null MX tells senders the name accepts no mail, so they may drop mail addressed to it, and receivers may refuse mail it sends. Checked only on names that appear to take or send mail.",
        severity: "warning",
        score: 5,
        docs: "https://www.rfc-editor.org/rfc/rfc7505#section-4",
        fix: recordFix("Delete the MX record that says the name takes no mail, and keep the MX records of its real mail servers.", { Name: "{host}", "Mail server": ".", "Zone file": "{host}. MX 0 ." }),
    },
    "dns/spf/duplicate": {
        fact: "site.hosts.*.mail.spf",
        when: ACTIVE,
        expect: { minItems: 1, maxItems: 1 },
        message: "a name that takes or sends mail needs exactly one v=spf1 record, since none lets anyone send as it and two fail every check (got {got})",
        title: "A mail name has no SPF record or more than one",
        rationale: "With no SPF record, nobody can check which servers may send as the name; with two, every check fails and receivers may reject genuine mail. Checked only on names that take or send mail.",
        severity: "warning",
        score: 5.8,
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-4.5",
        fix: recordFix("Keep one SPF record for the name, listing every server that sends its mail, for example:", { Name: "{host}", Content: "v=spf1 mx -all" }, "Move the servers the other TXT records starting with `v=spf1` list into it, then delete those records."),
    },
    "dns/spf-all/weak": {
        fact: "site.hosts.*.mail.spf",
        when: ACTIVE,
        expect: { items: { pattern: String.raw`\s([-~][aA][lL][lL]|[rR][eE][dD][iI][rR][eE][cC][tT]=\S+)(\s|$)` } },
        message: "SPF does not end in -all or ~all, so receivers let any server send as this name (got {got})",
        title: "The SPF record does not end in -all or ~all",
        rationale: "Without a closing -all, ~all or redirect, receivers let any server send as the name, so forged mail passes the SPF check. Checked only on names that take or send mail.",
        severity: "warning",
        score: 5.7,
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.1",
        fix: recordFix("End the SPF record in `-all`, so receivers refuse mail from servers it does not list, for example:", { Name: "{host}", Content: "v=spf1 mx -all" }, "While you are still finding every server that sends your mail, end it in `~all`, which marks mail from other servers as suspect instead."),
    },
    "dns/dmarc/missing": {
        fact: "site.hosts.*.mail.dmarc",
        when: ACTIVE,
        expect: { type: "object" },
        message: "no DMARC record applies to a name that takes or sends mail, so receivers deliver mail forged from it",
        title: "A mail name has no DMARC record",
        rationale: "Without DMARC, receivers deliver mail forged from the name, so recipients can be phished under its identity. Checked only on names that take or send mail.",
        severity: "warning",
        score: 6.2,
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: recordFix("Add a TXT record for DMARC.", DMARC_QUARANTINE, DMARC_REJECT_LATER),
    },
    "dns/dmarc-policy/weak": {
        fact: "site.hosts.*.mail.dmarc",
        when: { ...ACTIVE, "site.hosts.*.mail.dmarc": { type: "object" } },
        expect: { type: "object", required: ["policy"], properties: { policy: { enum: ["quarantine", "reject"] } } },
        message: "the DMARC policy neither quarantines nor rejects, so receivers deliver mail forged from a name that takes or sends mail (got {got})",
        title: "The DMARC policy neither quarantines nor rejects",
        rationale: "A policy of none asks receivers to deliver forged mail anyway, so phishing sent in the name’s identity still reaches inboxes. Checked only on names that take or send mail and publish DMARC.",
        severity: "warning",
        score: 6.2,
        docs: "https://www.rfc-editor.org/rfc/rfc9989#section-4.7",
        fix: recordFix("Change the TXT record for DMARC to quarantine mail that fails its checks.", DMARC_QUARANTINE, DMARC_REJECT_LATER),
    },
};

const RULES: Record<string, RuleSpec> = {
    "dns/https-record/missing": {
        fact: "site.hosts.*.dns.https",
        expect: { minItems: 1 },
        message: "no HTTPS record, so a first visit learns h3 and ECH only from Alt-Svc, one connection late",
        title: "The host has no HTTPS DNS record",
        rationale: "Without it, a browser’s first visit learns about HTTP/3 and Encrypted Client Hello only from the Alt-Svc header, one connection later, so first loads are slower and less private.",
        severity: "warning",
        score: 3.8,
        docs: "https://www.rfc-editor.org/rfc/rfc9460",
        fix: recordFix(
            "Add an HTTPS record, so browsers learn on their first visit which protocols the site speaks.",
            { Name: "{host}", Priority: "1", Target: ".", Value: 'alpn="h3,h2"', "Zone file": '{host}. 3600 IN HTTPS 1 . alpn="h3,h2"' },
            "A Target of `.` means the name itself. Leave `h3` out of the value if the site does not serve HTTP/3.",
        ),
    },
    "dns/https-alpn/mismatch": {
        fact: "site.hosts.*.dns.h3",
        expect: { anyOf: [{ properties: { record: { const: true }, "alt-svc": { const: true } } }, { properties: { record: { const: false }, "alt-svc": { const: false } } }] },
        message: "the HTTPS record and Alt-Svc disagree about h3 (got {got})",
        title: "The HTTPS record and Alt-Svc disagree about HTTP/3",
        rationale: "When the DNS record and the header differ on whether HTTP/3 is available, browsers get conflicting advice and may try a protocol the server does not serve or skip one it does.",
        severity: "warning",
        score: 3.5,
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.1",
        fix: "Keep the HTTPS record’s h3 flag and the Alt-Svc h3 advertisement in agreement.",
    },
    "dns/https-hints/mismatch": {
        fact: "site.hosts.*.dns.https",
        expect: { items: { properties: { "hints-match": { const: true } } } },
        message: "ipv4hint or ipv6hint does not match the A and AAAA records",
        title: "The HTTPS record’s address hints do not match A and AAAA",
        rationale: "Browsers that trust ipv4hint or ipv6hint connect to addresses the host no longer has, or never try those it does, so connections fail or slow down. Checked only where the record points at the host itself.",
        severity: "warning",
        score: 3.6,
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.3",
        fix: "Update the IPv4 and IPv6 hints in the HTTPS record to match the current A and AAAA sets.",
    },
    "dns/caa/missing": {
        fact: "site.hosts.*.dns.caa",
        expect: { type: "object", properties: { records: { contains: { properties: { tag: { enum: ["issue", "issuewild"] } } } } } },
        message: "no CAA issue or issuewild record on the host or any parent, so any CA may issue for it",
        title: "The host has no CAA record",
        rationale: "Without a CAA issue or issuewild record on the host or any parent name, any certificate authority may issue a certificate for it, so a mistaken or fraudulent issuance is easier to obtain.",
        severity: "warning",
        score: 4,
        docs: "https://www.rfc-editor.org/rfc/rfc8659",
        fix: recordFix(
            "Add a CAA record for each certificate authority you use; it covers every name under `{domain}`.",
            { Name: "{domain}", Flags: "0", Tag: "issue", "CA domain": "letsencrypt.org", "Zone file": '{domain}. CAA 0 issue "letsencrypt.org"' },
            "Put your own authority’s domain in place of `letsencrypt.org`.",
        ),
    },
    "dns/caa-issuer/mismatch": {
        fact: "site.hosts.*.dns.caa.issuer",
        expect: { properties: { allowed: { const: true } } },
        when: { "site.hosts.*.dns.caa.issuer": { type: "object" } },
        message: "CAA does not allow the CA that issued the served certificate (got {got})",
        title: "CAA does not allow the CA that issued the served certificate",
        rationale: "Certificate authorities must refuse what CAA does not allow, so the next renewal from this CA fails and visitors then see an expired certificate. Checked only where CAA records exist and the issuer is known.",
        severity: "error",
        score: 8.6,
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.2",
        fix: "Add an issue or issuewild tag to CAA for the CA that holds the certificate.",
    },
    "dns/caa-iodef/missing": {
        fact: "site.hosts.*.dns.caa.records",
        expect: { contains: { properties: { tag: { const: "iodef" } } } },
        when: { "site.hosts.*.dns.caa": { type: "object" } },
        message: "CAA names no iodef address for refused issuance reports",
        title: "CAA names no contact for issuance reports",
        rationale: "Without an iodef tag, a certificate authority that refuses or doubts a request for the name has nowhere to report it. Checked only where CAA records exist.",
        severity: "info",
        score: 2.8,
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.4",
        fix: "Add a CAA iodef tag pointing at a contact URI or email for issuance incident reports.",
        extra: ["Report Relay https://dbuho.me/project/report-relay/ collects these reports and sends them to your Grafana: open source, self-hosted, free."],
    },
    "dns/caa-flags/invalid": {
        fact: "site.hosts.*.dns.caa.records",
        expect: { not: { contains: { properties: { flags: { minimum: 128 }, tag: { not: { enum: ["issue", "issuewild", "iodef"] } } } } } },
        when: { "site.hosts.*.dns.caa": { type: "object" } },
        message: "CAA marks a tag outside RFC 8659 critical, so a CA that does not know it refuses to issue at all (got {got})",
        title: "CAA marks an unknown tag as critical",
        rationale: "A certificate authority that does not know a critical tag must refuse to issue, so certificate issuance and renewal for the name can fail outright. Checked only where CAA records exist.",
        severity: "error",
        score: 7.2,
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.5",
        fix: "Set the CAA flags to `0` on the unknown tag, or remove the record.",
    },
    "dns/aaaa/missing": {
        fact: "site.hosts.*.dns.aaaa",
        expect: { minItems: 1 },
        message: "no AAAA record, so the host is unreachable over IPv6",
        title: "The host has no IPv6 address",
        rationale: "Visitors on IPv6-only networks cannot reach the host, and everyone else misses the IPv6 path where it is faster.",
        severity: "info",
        score: 1.4,
        docs: "https://www.rfc-editor.org/rfc/rfc3596",
        fix: "Publish an AAAA record with the host’s IPv6 address.",
    },
    "dns/cname-chain/excessive": {
        fact: "site.hosts.*.dns.cname",
        expect: { maxItems: 2 },
        message: "the name resolves through {got} of CNAME hops",
        title: "The name resolves through a long chain of CNAME aliases",
        rationale: "Every CNAME hop costs the resolver another lookup, which delays the first visit, and some resolvers give up on long chains. Flagged above two hops.",
        severity: "info",
        score: 1.6,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-3.6.2",
        fix: "Cut the CNAME chain at one hop by pointing the alias directly at the target’s A or AAAA.",
    },
    "dns/cname/insecure": {
        fact: "site.hosts.*.dns.dangling",
        expect: { const: false },
        linked: true,
        message: "the name is a CNAME to a name that does not exist, open to takeover (got {got})",
        title: "A CNAME points to a name that does not exist",
        rationale: "Anyone who registers or claims the missing target can serve content under the site’s name, enabling phishing, cookie theft or defacement. Checked on crawled and linked names.",
        severity: "error",
        score: 9.2,
        docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Subdomain_takeovers",
        fix: "Delete the dangling CNAME, or claim the delegated name before a third party can.",
    },
    "dns/dnssec/missing": {
        fact: "site.hosts.*.dnssec.signed",
        expect: { const: true },
        message: "the zone is not signed with DNSSEC",
        title: "The zone is not signed with DNSSEC",
        rationale: "Without signatures, resolvers cannot detect forged DNS answers, so an attacker on the path can send visitors and mail to a different server.",
        severity: "warning",
        score: 5.6,
        docs: "https://www.rfc-editor.org/rfc/rfc9364",
        fix: "Enable DNSSEC signing on the zone and publish a DS record at the parent.",
    },
    "dns/dnssec/broken": {
        fact: "site.hosts.*.dnssec.bogus",
        expect: { const: false },
        when: { "site.hosts.*.dnssec.bogus": { type: "boolean" } },
        message: "the zone is signed but fails validation, so every validating resolver answers SERVFAIL",
        title: "The zone’s DNSSEC signatures fail validation",
        rationale: "Validating resolvers answer SERVFAIL, so everyone behind them cannot reach the site or its mail. Checked only when the resolver validates DNSSEC.",
        severity: "error",
        score: 8.8,
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-5.5",
        fix: "Fix the broken DS or DNSKEY at the parent or the zone so the chain of trust validates.",
    },
    "dns/dnssec-algorithm/deprecated": {
        fact: "site.hosts.*.dnssec",
        expect: { properties: { ds: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } }, "digest-type": { not: { enum: WEAK_DIGESTS } } } } }, dnskey: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } } } } } } },
        when: { "site.hosts.*.dnssec.signed": true },
        message: "the zone signs or digests with an algorithm RFC 8624 forbids",
        title: "The zone uses a DNSSEC algorithm that is no longer allowed",
        rationale: "RFC 8624 forbids the signing algorithm or DS digest, so resolvers may treat the zone as unsigned and its protection against forged answers weakens. Checked only on signed zones.",
        severity: "warning",
        score: 4.2,
        docs: "https://www.rfc-editor.org/rfc/rfc8624#section-3.1",
        fix: "Re-sign the zone and republish its DS with a non-deprecated algorithm.",
    },
    "dns/rrsig/expiring": {
        fact: "site.hosts.*.dnssec.rrsig",
        expect: { properties: { left: { minimum: 0.25 } } },
        when: { "site.hosts.*.dnssec.rrsig": { type: "object" } },
        message: "less than a quarter of the host’s signature validity is left, so re-signing has stalled (got {got})",
        title: "The zone’s DNSSEC signatures are close to expiring",
        rationale: "With under a quarter of the validity left, re-signing has probably stalled; once the signatures expire, validating resolvers fail every lookup and the site and its mail vanish for their users.",
        severity: "warning",
        score: 4.4,
        docs: "https://www.rfc-editor.org/rfc/rfc6781#section-4.4.2",
        fix: "Re-sign the zone and fix the process that stopped refreshing RRSIGs.",
    },
    "dns/nsec3-iterations/excessive": {
        fact: "site.hosts.*.dnssec.nsec3",
        expect: { properties: { iterations: { const: 0 }, "salt-length": { const: 0 } } },
        when: { "site.hosts.*.dnssec.nsec3": { type: "object" } },
        message: "NSEC3 uses extra iterations or a salt (got {got})",
        title: "NSEC3 uses extra hashing iterations or a salt",
        rationale: "Per RFC 9276, extra iterations and a salt add resolver work without real protection, and some resolvers treat such answers as insecure. Checked only on zones that use NSEC3.",
        severity: "warning",
        score: 3.3,
        docs: "https://www.rfc-editor.org/rfc/rfc9276#section-3.1",
        fix: "Disable NSEC3 iterations and salt, or migrate to NSEC by removing the NSEC3PARAM records.",
    },
    "dns/ns/single": {
        fact: "site.hosts.*.nameservers.servers",
        expect: { minItems: 2 },
        message: "the zone has {got} name servers, fewer than 2",
        title: "The zone has a single name server",
        rationale: "When that server is down, nobody can resolve the site or its mail. Flagged when fewer than two name servers are listed.",
        severity: "warning",
        score: 5.4,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.1",
        fix: "Add a second name server at a different network from the first.",
    },
    "dns/ns-serial/mismatch": {
        fact: "site.hosts.*.nameservers",
        expect: { properties: { serials: { maxItems: 1 } } },
        when: { "site.hosts.*.nameservers.serials": { type: "array" } },
        message: "the name servers serve different SOA serials, so a zone change reaches some of them late (got {got})",
        title: "The name servers serve different versions of the zone",
        rationale: "The servers report different SOA serials, so a change to the zone reaches some visitors late, depending on which server their resolver asks.",
        severity: "warning",
        score: 5.3,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.3.5",
        fix: "Sync the zone to every name server and bump the SOA serial.",
    },
    "dns/ns-delegation/broken": {
        fact: "site.hosts.*.nameservers.lame",
        expect: { maxItems: 0 },
        when: { "site.hosts.*.nameservers.lame": { type: "array" } },
        message: "these name servers are listed for the zone but do not answer for it, a leftover of a decommissioned provider or a zone never loaded: {got}; a resolver that picks one waits out a timeout or gets a refusal",
        title: "Listed name servers do not answer for the zone",
        rationale: "A resolver that picks one of these leftovers of an old provider or an unloaded zone waits out a timeout or gets a refusal, so lookups slow down or fail.",
        severity: "warning",
        score: 5.5,
        docs: "https://www.rfc-editor.org/rfc/rfc1912#section-2.8",
        fix: "Delete the NS records of `{domain}` that name these servers, at the DNS provider and at the registrar, or load the zone on them.",
    },
    "dns/ns-answers/mismatch": {
        fact: "site.hosts.*.nameservers.differing",
        expect: { maxItems: 0 },
        when: { "site.hosts.*.nameservers.differing": { type: "array" } },
        message: "the name servers answer the host differently, so what a visitor reaches depends on which one their resolver asks: {got}",
        title: "The name servers answer the host differently",
        rationale: "Visitors reach different addresses depending on which server their resolver asks, so some may land on a stale or wrong server.",
        severity: "warning",
        score: 5.8,
        fix: "Sync the zone on every name server and bump its SOA serial.",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.3.5",
    },
    "dns/ns-resolver/mismatch": {
        fact: "site.hosts.*.nameservers.resolver-agrees",
        expect: { const: true },
        when: { "site.hosts.*.nameservers.resolver-agrees": { type: "boolean" } },
        message: "the configured resolver answers the host differently from its name servers, a cached old answer or a split view",
        title: "The resolver’s answer differs from the name servers’ answer",
        rationale: "A cached old answer or a split view means some visitors still reach an old address after a change.",
        severity: "info",
        score: 2.4,
        fix: "Wait out the old record’s TTL, or check which view the resolver serves.",
        docs: "https://www.rfc-editor.org/rfc/rfc2181#section-5.4.1",
    },
    "dns/resolver-rcode/broken": {
        fact: "site.hosts.*.resolvers.rcodes",
        expect: { maxItems: 1 },
        message: "the compared resolvers disagree on whether the host resolves (got {got}); a SERVFAIL on a validating resolver alone points at DNSSEC",
        title: "The compared resolvers disagree on whether the host resolves",
        rationale: "Some resolvers answer while others fail, so part of the visitors cannot reach the site; a SERVFAIL on validating resolvers alone points at a broken DNSSEC chain. Checked only when several resolvers are compared.",
        severity: "warning",
        score: 4.6,
        fix: "Query each resolver named in the finding and fix what the failing one reports, a broken DNSSEC chain first.",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-5.5",
    },
    "dns/resolver-answers/mismatch": {
        fact: "site.hosts.*.resolvers.answer-sets",
        expect: { maximum: 1 },
        when: { "site.hosts.*.resolvers.answer-sets": { type: "integer" } },
        message: "the compared resolvers give {got} different answers for the host; geo-DNS does this on purpose, a stale or split view does not",
        title: "The compared resolvers give different addresses for the host",
        rationale: "Geo-DNS does this on purpose; a stale or split view does not, and it sends some visitors to an old or wrong server. Checked only when several resolvers are compared.",
        severity: "info",
        fix: "If the answers should match, wait out the old TTL or fix the view that differs.",
        docs: "https://www.rfc-editor.org/rfc/rfc2181#section-5.4.1",
    },
    "dns/resolver-validation/broken": {
        fact: "site.hosts.*.resolvers.validated",
        expect: { maxItems: 1 },
        when: { "site.hosts.*.dnssec.signed": true },
        message: "some compared resolvers validate the signed zone and some do not (got {got})",
        title: "Resolvers disagree on whether the signed zone validates",
        rationale: "Some compared resolvers validate the signed zone and some do not, which points at a DS or key problem that fails lookups for visitors behind validating resolvers. Checked only on signed zones.",
        severity: "info",
        score: 1.8,
        fix: "Check the DS at the parent and the DNSKEY set against each resolver’s trust anchors.",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-4.3",
    },
    "dns/ns-delegation/mismatch": {
        fact: "site.hosts.*.nameservers.delegation.differs",
        expect: { maxItems: 0 },
        when: { "site.hosts.*.nameservers.delegation.differs": { type: "array" } },
        message: "the parent zone and the zone’s own NS records name different servers, so resolvers reach a server the zone disowns or skip one it lists: {got}",
        title: "The parent zone and the zone list different name servers",
        rationale: "Resolvers reach a server the zone disowns or skip one it lists, so lookups can fail or return stale data.",
        severity: "warning",
        score: 5.2,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.2.2",
        fix: "Make the NS records of `{domain}` in your DNS panel list the same name servers as those set at the registrar.",
    },
    "dns/agents/missing": {
        fact: "site.hosts.*.dns.agents",
        expect: { type: "array", minItems: 1 },
        message: "no DNS-AID entry point at _index._agents, so an agent cannot find the zone’s agent services through DNS",
        title: "The zone has no DNS-AID entry point for agents",
        rationale: "Without a record at _index._agents, AI agents cannot discover the zone’s agent services through DNS.",
        severity: "hint",
        score: 0.8,
        docs: "https://specification.website/spec/agent-readiness/dns-aid/",
        fix: recordFix(
            "Add an HTTPS record that tells agents which host serves the site.",
            { Name: "_index._agents.{domain}", Priority: "1", Target: "{host}.", Value: 'alpn="h3,h2" port=443', "Zone file": '_index._agents.{domain}. 3600 IN HTTPS 1 {host}. alpn="h3,h2" port=443' },
            "For each agent service, add one more such record with the service’s own host as Target, at `_mcp._agents.{domain}` for an MCP server or `_a2a._agents.{domain}` for an A2A agent. The record format is in [RFC 9460](https://www.rfc-editor.org/rfc/rfc9460#section-2.3) and [DNS-AID](https://datatracker.ietf.org/doc/draft-mozleywilliams-dnsop-dnsaid/).",
        ),
    },
    "dns/apex-cname/present": {
        fact: "site.hosts.*.dns.apex-cname",
        expect: { const: false },
        when: { "site.hosts.*.dns.apex-cname": { type: ["string", "boolean"] } },
        message: "the zone apex is a CNAME to {got}, which cannot sit beside the apex’s SOA and NS records",
        title: "The zone apex is a CNAME",
        rationale: "A CNAME cannot sit beside the SOA and NS records every apex has, so resolvers may fail on the zone itself or on its mail and name server records.",
        severity: "warning",
        score: 4.8,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-3.6.2",
        fix: "Delete the CNAME record of `{domain}`, then add A and AAAA records with the addresses it led to, or the ALIAS or flattened CNAME record your DNS provider offers in its place.",
    },
    "dns/soa-timers/range": {
        fact: "site.hosts.*.nameservers.soa",
        expect: { properties: { refresh: { minimum: 1200, maximum: 43_200 }, expire: { minimum: 1_209_600, maximum: 2_419_200 }, minimum: { minimum: 300, maximum: 86_400 }, "retry-below-refresh": { const: true }, "mname-listed": { const: true } } },
        when: { "site.hosts.*.nameservers.soa": { type: "object" }, "site.hosts.*.nameservers.provider.soa-editable": { not: { const: false } } },
        message: "the SOA {field} is {got}, outside what RFC 1912 §2.2 recommends: refresh 1200–43200 s, retry below refresh, expire 1209600–2419200 s, minimum 300–86400 s, a listed name server as primary",
        title: "The SOA timers are outside the recommended ranges",
        rationale: "Refresh, retry, expire or minimum values far from RFC 1912’s ranges slow the spread of changes or make secondary servers drop the zone too early. Skipped where the DNS provider manages the SOA.",
        severity: "info",
        score: 1.2,
        docs: "https://www.rfc-editor.org/rfc/rfc1912#section-2.2",
        fix: "Set the SOA of `{domain}` to refresh 7200, retry 3600, expire 1209600 and minimum 3600, with one of its name servers as the primary.",
    },
    "dns/ttl/range": {
        fact: "site.hosts.*.nameservers.ttl",
        expect: { properties: { a: { minimum: 300, maximum: 86_400 }, aaaa: { minimum: 300, maximum: 86_400 }, mx: { minimum: 300, maximum: 86_400 }, ns: { minimum: 300, maximum: 172_800 } } },
        when: { "site.hosts.*.nameservers.ttl": { type: "object" } },
        message: "a record TTL sits outside 300 seconds to one day, two for NS; fine just before a migration, costly otherwise (got {got})",
        title: "A record’s TTL is very short or very long",
        rationale: "A TTL under 300 seconds multiplies DNS load and lookup delay; over a day, a fix or a migration takes that long to reach visitors. NS records may go up to two days.",
        severity: "hint",
        score: 0.6,
        docs: "https://www.rfc-editor.org/rfc/rfc1912#section-2.2",
        fix: "Set the TTL of the A, AAAA and MX records of `{host}` between 300 and 86400 seconds, and of its NS records up to 172800.",
    },
    "dns/recursion/insecure": {
        fact: "site.hosts.*.nameservers.servers",
        expect: { items: { properties: { recursive: { not: { const: true } } } } },
        message: "an authoritative name server answers recursive queries for any name, which lends it to amplification attacks and cache poisoning",
        title: "An authoritative name server answers recursive queries",
        rationale: "Open to anyone, it can be abused for traffic amplification attacks and cache poisoning.",
        severity: "warning",
        score: 6,
        docs: "https://www.rfc-editor.org/rfc/rfc5358",
        fix: "Turn recursion off on the authoritative name servers of `{domain}`, or allow it to your own networks only.",
    },
    "domain/registration/expiring": {
        fact: "site.hosts.*.rdap.days-left",
        expect: { type: "integer", minimum: 30 },
        message: "the domain registration expires in {got} days, and the site and its mail stop resolving when it lapses",
        title: "The domain registration expires within 30 days",
        rationale: "When it lapses, the site and its mail stop resolving and someone else can register the name. Checked only for registered domains that the RDAP lookup finds.",
        severity: "error",
        score: [
            [0, 9.6],
            [6, 7],
            [7, 6.5],
            [30, 3.5],
        ],
        docs: "https://www.rfc-editor.org/rfc/rfc9083#section-4.5",
        fix: "Renew `{domain}` at its registrar and turn on automatic renewal.",
    },
    "domain/transfer-lock/missing": {
        fact: "site.hosts.*.rdap.status",
        expect: { type: "array", contains: { enum: ["client transfer prohibited", "server transfer prohibited"] } },
        message: "the registration carries no transfer lock, so whoever takes over the registrar account can move the domain away (status {got})",
        title: "The domain has no transfer lock",
        rationale: "Whoever takes over the registrar account can move the domain to another registrar, and the site and mail go with it.",
        severity: "warning",
        score: 6.2,
        docs: "https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en",
        fix: "Turn on the transfer lock (clientTransferProhibited) for `{domain}` at its registrar.",
    },
    "domain/ns-registry/mismatch": {
        fact: "site.hosts.*.rdap.ns-differs",
        expect: { maxItems: 0 },
        when: { "site.hosts.*.rdap.ns-differs": { type: "array" } },
        message: "the name servers the registry lists differ from the zone’s own NS records: {got}",
        title: "The registry and the zone list different name servers",
        rationale: "Resolvers may be sent to servers the zone’s owner does not control or does not know, so answers can be wrong or missing.",
        severity: "warning",
        score: 5,
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.2.2",
        fix: "Make the name servers set at the registrar list the same servers as the NS records of `{domain}` in your DNS panel.",
    },
    "dns/ns-network/single": {
        fact: "site.hosts.*.nameservers.networks",
        expect: { minimum: 2 },
        message: "every name server address sits in one /24 or /48",
        title: "All name servers sit in one network",
        rationale: "If that one /24 or /48 network fails, every name server goes down together, and the site and its mail with them.",
        severity: "info",
        score: 2.2,
        docs: "https://www.rfc-editor.org/rfc/rfc2182#section-3.1",
        fix: "Place name servers on addresses in different /24 or /48 networks.",
    },
};

const CORE = ["dns/https-record/missing", "dns/caa/missing", "dns/caa-issuer/mismatch", "dns/caa-iodef/missing", "dns/caa-flags/invalid", "dns/cname/insecure", "dns/dnssec/missing", "dns/dnssec/broken"];
const RECOMMENDED = [...CORE, "domain/registration/expiring", "domain/transfer-lock/missing", "dns/recursion/insecure"];

// The `RULES` entries named by `ids`.
const pick = (ids: string[]): Record<string, RuleSpec> => Object.fromEntries(ids.map((id) => [id, RULES[id] as RuleSpec]));

// Records, CAA, DNSSEC and name servers of every crawled host, asked of the configured resolver.

export default {
    name: "dns",
    settings: { type: "object", additionalProperties: false, properties: { compare: { type: "array", items: { type: "string", minLength: 1 }, default: [] }, rdap: { type: "boolean", default: true } } },
    sites: [addresses, dnssec, nameservers, resolvers, rdap],
    presets: {
        dns: { description: "DNS and registration of every crawled host: HTTPS records, CAA, DNSSEC, name servers, zone timers, dangling CNAMEs, RDAP expiry and lock", rules: RULES },
        "dns:mail": { description: "Mail records matched to what each name does: a null MX, a deny-all SPF and a DMARC reject policy where it takes and sends no mail, one closed SPF record and an enforced DMARC policy where it does", rules: MAIL_RULES },
        "dns:core": { description: "HTTPS record, CAA and its iodef contact, DNSSEC state and dangling CNAMEs, a handful of queries per host", rules: pick(CORE) },
        "dns:recommended": { description: "dns:core, the registration’s expiry and transfer lock, and name servers open to recursion", rules: pick(RECOMMENDED) },
    },
} satisfies Plugin;
