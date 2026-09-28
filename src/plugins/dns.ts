// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { Answer, CaaData, DnskeyData, DsData, MxData, RrsigData, SoaData } from "dns-packet";
import { getDomain } from "tldts";
import { Bucket } from "../cache/index.ts";
import { dnsClient, parseResolver, type DnsClient, type Reply, type StoredReply } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { parseSvcb, type Svcb } from "../crawl/svcb.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

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

// `org.spiderlint.dns`: public resolvers to compare the configured one with; none by default, so no third party is asked.
export interface DnsSettings {
    compare: string[];
}

// The answers of `type`, in wire order.
export function records<T>(reply: Reply, type: string): Data<T>[] {
    return reply.answers.filter((answer) => answer.type === type) as Data<T>[];
}

// Each TXT record’s character-strings joined, as RFC 7208 §3.3 reads them.
export function texts(reply: Reply): string[] {
    return records<Buffer | Buffer[]>(reply, "TXT").map(({ data }) => (Array.isArray(data) ? data : [data]).map((chunk) => chunk.toString("utf8")).join(""));
}

// Parsed SVCB-shaped records of `type` (`UNKNOWN_64` SVCB, `UNKNOWN_65` HTTPS); an unparsable one warns and is dropped.
function services(host: string, reply: Reply, type: string): Svcb[] {
    return records<Buffer>(reply, type).flatMap(({ data }) => {
        try {
            return [parseSvcb(data)];
        } catch (error) {
            log.warn({ host, type, error: reason(error) }, "SVCB record unparsable");
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
    resolves: true,
    async extract(host, context) {
        if (context.linked) {
            if (isIP(host) !== 0 || isSpecialUse(host)) return;
            const a = await context.dns.query(host, "A");
            return { cname: records<string>(a, "CNAME").map(({ name, data, ttl }) => ({ name, target: data, ttl })), dangling: dangling(host, a) };
        }
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [a, aaaa, https, sale, agents] = await Promise.all([context.dns.query(host, "A"), context.dns.query(host, "AAAA"), context.dns.query(host, "UNKNOWN_65"), context.dns.query(`_for-sale.${zone}`, "TXT"), context.dns.query(`_agents.${zone}`, "UNKNOWN_64")]);
        const v4 = records<string>(a, "A").map(({ data, ttl }) => ({ address: data, ttl }));
        const v6 = records<string>(aaaa, "AAAA").map(({ data, ttl }) => ({ address: data, ttl }));
        const hinted = services(host, https, "UNKNOWN_65").map((record): Svcb & { "hints-match"?: boolean } => {
            const isHinted = record.ipv4hint !== undefined || record.ipv6hint !== undefined;
            return isHinted && (record.target === "." || isSameName(record.target, host)) ? { ...record, "hints-match": isSameSet(record.ipv4hint ?? [], v4.map((entry) => entry.address)) && isSameSet(record.ipv6hint ?? [], v6.map((entry) => entry.address)) } : record;
        });
        const forSale = texts(sale);
        const agentServices = services(host, agents, "UNKNOWN_64");
        const authorised = await caa(host, zone, context.dns);
        const allowed = authorised && issuer(host, authorised, context.pages);
        const broken = dangling(host, a);
        log.debug({ host, zone, a: v4.length, aaaa: v6.length, https: hinted.length, caa: authorised?.at, dangling: broken, forSale: forSale.length, agents: agentServices.length }, "dns records read");
        return {
            zone,
            a: v4,
            aaaa: v6,
            cname: records<string>(a, "CNAME").map(({ name, data, ttl }) => ({ name, target: data, ttl })),
            https: hinted,
            ...(hinted.some((record) => record.priority > 0) && { h3: { record: hinted.some((record) => record.alpn?.includes("h3")), "alt-svc": hasAltSvcH3(context.pages) } }),
            ...(authorised && { caa: { ...authorised, ...(allowed && { issuer: allowed }) } }),
            dangling: broken,
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
        const failed = isSigned && await bogus(host, a, context);
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
    return groups.slice(0, 3).map((group) => Number.parseInt(group, 16).toString(16)).join(":");
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
async function nameServer(zone: string, host: string, name: string, dns: DnsClient): Promise<{ name: string; addresses: string[]; "soa-serial"?: number; authoritative?: boolean; answers?: string[] }> {
    const [a, aaaa] = await Promise.all([dns.query(name, "A"), dns.query(name, "AAAA")]);
    const addresses = [...records<string>(a, "A"), ...records<string>(aaaa, "AAAA")].map(({ data }) => data);
    if (!dns.canQueryDirectly) return { name, addresses };
    for (const address of addresses) {
        try {
            const reply = await dns.query(zone, "SOA", { server: address });
            const serial = records<SoaData>(reply, "SOA")[0]?.data.serial;
            const { answers } = await hostAnswers(host, dns, { server: address });
            log.debug({ zone, host, name, address, aa: reply.aa, serial, answers }, "name server asked directly");
            return { name, addresses, ...(serial !== undefined && { "soa-serial": serial }), authoritative: reply.aa && serial !== undefined, answers };
        } catch (error) {
            log.debug({ zone, name, address, error: reason(error) }, "name server unreachable");
        }
    }
    return { name, addresses, authoritative: false };
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
        log.debug({ host, zone, servers: names.length, serials, networks, sets: sets.length, resolverAgrees: agreement?.["resolver-agrees"] }, "name servers read");
        return { zone, servers, networks, ...(context.dns.canQueryDirectly && { serials }), ...agreement };
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

// The DMARC record at the host, else at its organisational domain, with the policy that applies to the host (RFC 7489 §6.6.3).
async function dmarc(host: string, dns: DnsClient): Promise<{ at: string; record: string; policy?: string } | undefined> {
    const names = new Set([host, getDomain(host, { allowPrivateDomains: true }) ?? host]);
    for (const name of names) {
        const record = texts(await dns.query(`_dmarc.${name}`, "TXT")).find((entry) => /^v=DMARC1\s*(;|$)/i.test(entry));
        log.debug({ host, name, found: record !== undefined }, "dmarc looked up");
        if (!record) continue;
        const tags = new Map(record.split(";").map((tag) => tag.split("=", 2).map((part) => part.trim().toLowerCase()) as [string, string]));
        const policy = name === host ? tags.get("p") : (tags.get("sp") ?? tags.get("p"));
        return { at: name, record, ...(policy && { policy }) };
    }
}

// MX, SPF and DMARC of one host, for the `dns:mail` rules a name that sends no mail passes.
const mail: SiteExtractor = {
    id: "mail",
    per: "host",
    cached: false,
    resolves: true,
    async extract(host, context) {
        const zone = await zoneOf(host, context.dns);
        if (!zone) return;
        const [mx, txt, policy] = await Promise.all([context.dns.query(host, "MX"), context.dns.query(host, "TXT"), dmarc(host, context.dns)]);
        const exchanges = records<MxData>(mx, "MX").map(({ data }) => ({ preference: data.preference ?? 0, exchange: data.exchange }));
        const spf = texts(txt).filter((entry) => /^v=spf1(\s|$)/i.test(entry));
        log.debug({ host, zone, mx: exchanges.length, spf: spf.length, dmarc: policy?.policy }, "mail records read");
        return { mx: exchanges, spf, ...(policy && { dmarc: policy }) };
    },
};

const MAIL: Record<string, RuleSpec> = {
    "dns/null-mx": {
        fact: "site.hosts.*.mail.mx",
        expect: { minItems: 1, maxItems: 1, items: { properties: { preference: { const: 0 }, exchange: { const: "." } } } },
        message: "no null MX, so senders fall back to the name’s A or AAAA address and retry mail it never takes for days (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7505",
        fix: "Add one MX record — Name `{host}`, Mail server `.`, Priority `0`, in a zone file `{host}. MX 0 .` — and delete every other MX of the name.",
    },
    "dns/spf-none": {
        fact: "site.hosts.*.mail.spf",
        expect: { minItems: 1, maxItems: 1, items: { pattern: String.raw`^[vV]=[sS][pP][fF]1\s+-[aA][lL][lL]\s*$` } },
        message: "SPF is not a lone v=spf1 -all, so receivers cannot refuse mail forged from this name (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7208#section-5.1",
        fix: "Add one TXT record — Name `{host}`, Content `v=spf1 -all` — and delete every other `v=spf1` record of the name, since SPF is not inherited by subdomains.",
    },
    "dns/dmarc-reject": {
        fact: "site.hosts.*.mail.dmarc",
        expect: { type: "object", required: ["policy"], properties: { policy: { const: "reject" } } },
        message: "no DMARC policy of reject applies to the name, so receivers accept mail forged from it (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc7489#section-6.3",
        fix: "Add one TXT record — Name `_dmarc.{domain}`, Content `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` — which covers `{domain}` and every name under it.",
    },
};

const RULES: Record<string, RuleSpec> = {
    "dns/https-record": {
        fact: "site.hosts.*.dns.https",
        expect: { minItems: 1 },
        message: "no HTTPS record, so a first visit learns h3 and ECH only from Alt-Svc, one connection late",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460",
        fix: "Publish an HTTPS record (TYPE 65) naming your ALPNs and addresses.",
    },
    "dns/https-alpn": {
        fact: "site.hosts.*.dns.h3",
        expect: { anyOf: [{ properties: { record: { const: true }, "alt-svc": { const: true } } }, { properties: { record: { const: false }, "alt-svc": { const: false } } }] },
        message: "the HTTPS record and Alt-Svc disagree about h3 (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.1",
        fix: "Keep the HTTPS record’s h3 flag and the Alt-Svc h3 advertisement in agreement.",
    },
    "dns/https-hints": {
        fact: "site.hosts.*.dns.https",
        expect: { items: { properties: { "hints-match": { const: true } } } },
        message: "ipv4hint or ipv6hint does not match the A and AAAA records",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9460#section-7.3",
        fix: "Update the IPv4 and IPv6 hints in the HTTPS record to match the current A and AAAA sets.",
    },
    "dns/caa": {
        fact: "site.hosts.*.dns.caa",
        expect: { type: "object" },
        message: "no CAA record on the host or any parent, so any CA may issue for it",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8659",
        fix: "Add one CAA record per CA you use — Name `{domain}`, Flags `0`, Tag `issue`, CA domain `letsencrypt.org` — which covers every name under it.",
    },
    "dns/caa-issuer": {
        fact: "site.hosts.*.dns.caa.issuer",
        expect: { properties: { allowed: { const: true } } },
        when: { "site.hosts.*.dns.caa.issuer": { type: "object" } },
        message: "CAA does not allow the CA that issued the served certificate (got {got})",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.2",
        fix: "Add an issue or issuewild tag to CAA for the CA that holds the certificate.",
    },
    "dns/caa-iodef": {
        fact: "site.hosts.*.dns.caa.records",
        expect: { contains: { properties: { tag: { const: "iodef" } } } },
        when: { "site.hosts.*.dns.caa": { type: "object" } },
        message: "CAA names no iodef address for refused issuance reports",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc8659#section-4.4",
        fix: "Add a CAA iodef tag pointing at a contact URI or email for issuance incident reports.",
    },
    "dns/aaaa": {
        fact: "site.hosts.*.dns.aaaa",
        expect: { minItems: 1 },
        message: "no AAAA record, so the host is unreachable over IPv6",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc3596",
        fix: "Publish an AAAA record with the host’s IPv6 address.",
    },
    "dns/cname-chain": {
        fact: "site.hosts.*.dns.cname",
        expect: { maxItems: 2 },
        message: "the name resolves through {got} of CNAME hops",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-3.6.2",
        fix: "Cut the CNAME chain at one hop by pointing the alias directly at the target’s A or AAAA.",
    },
    "dns/dangling-cname": {
        fact: "site.hosts.*.dns.dangling",
        expect: { const: false },
        linked: true,
        message: "the name is a CNAME to a name that does not exist, open to takeover (got {got})",
        severity: "error",
        docs: "https://developer.mozilla.org/en-US/docs/Web/Security/Subdomain_takeovers",
        fix: "Delete the dangling CNAME, or claim the delegated name before a third party can.",
    },
    "dns/dnssec": {
        fact: "site.hosts.*.dnssec.signed",
        expect: { const: true },
        message: "the zone is not signed with DNSSEC",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9364",
        fix: "Enable DNSSEC signing on the zone and publish a DS record at the parent.",
    },
    "dns/dnssec-bogus": {
        fact: "site.hosts.*.dnssec.bogus",
        expect: { const: false },
        when: { "site.hosts.*.dnssec.bogus": { type: "boolean" } },
        message: "the zone is signed but fails validation, so every validating resolver answers SERVFAIL",
        severity: "error",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-5.5",
        fix: "Fix the broken DS or DNSKEY at the parent or the zone so the chain of trust validates.",
    },
    "dns/dnssec-algorithm": {
        fact: "site.hosts.*.dnssec",
        expect: { properties: { ds: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } }, "digest-type": { not: { enum: WEAK_DIGESTS } } } } }, dnskey: { items: { properties: { algorithm: { not: { enum: WEAK_ALGORITHMS } } } } } } },
        when: { "site.hosts.*.dnssec.signed": true },
        message: "the zone signs or digests with an algorithm RFC 8624 forbids",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc8624#section-3.1",
        fix: "Re-sign the zone and republish its DS with a non-deprecated algorithm.",
    },
    "dns/rrsig-expiry": {
        fact: "site.hosts.*.dnssec.rrsig",
        expect: { properties: { left: { minimum: 0.25 } } },
        when: { "site.hosts.*.dnssec.rrsig": { type: "object" } },
        message: "less than a quarter of the host’s signature validity is left, so re-signing has stalled (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc6781#section-4.4.2",
        fix: "Re-sign the zone and fix the process that stopped refreshing RRSIGs.",
    },
    "dns/nsec3-iterations": {
        fact: "site.hosts.*.dnssec.nsec3",
        expect: { properties: { iterations: { const: 0 }, "salt-length": { const: 0 } } },
        when: { "site.hosts.*.dnssec.nsec3": { type: "object" } },
        message: "NSEC3 uses extra iterations or a salt (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc9276#section-3.1",
        fix: "Disable NSEC3 iterations and salt, or migrate to NSEC by removing the NSEC3PARAM records.",
    },
    "dns/ns-count": {
        fact: "site.hosts.*.nameservers.servers",
        expect: { minItems: 2 },
        message: "the zone has {got} name servers, fewer than 2",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.1",
        fix: "Add a second name server at a different network from the first.",
    },
    "dns/ns-consistent": {
        fact: "site.hosts.*.nameservers",
        expect: { properties: { servers: { items: { properties: { authoritative: { const: true } } } }, serials: { maxItems: 1 } } },
        when: { "site.hosts.*.nameservers.serials": { type: "array" } },
        message: "a name server is lame or the servers disagree on the SOA serial (got {got})",
        severity: "warning",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.3.5",
        fix: "Sync the zone to every name server and bump the SOA serial.",
    },
    "dns/ns-answers": {
        fact: "site.hosts.*.nameservers.answer-sets",
        expect: { maximum: 1 },
        when: { "site.hosts.*.nameservers.answer-sets": { type: "integer" } },
        message: "the name servers give {got} different answers for the host, so what a visitor reaches depends on which one their resolver asks",
        severity: "warning",
        fix: "Sync the zone on every name server and bump its SOA serial.",
        docs: "https://www.rfc-editor.org/rfc/rfc1034#section-4.3.5",
    },
    "dns/ns-resolver": {
        fact: "site.hosts.*.nameservers.resolver-agrees",
        expect: { const: true },
        when: { "site.hosts.*.nameservers.resolver-agrees": { type: "boolean" } },
        message: "the configured resolver answers the host differently from its name servers, a cached old answer or a split view",
        severity: "info",
        fix: "Wait out the old record’s TTL, or check which view the resolver serves.",
        docs: "https://www.rfc-editor.org/rfc/rfc2181#section-5.4.1",
    },
    "dns/resolver-rcode": {
        fact: "site.hosts.*.resolvers.rcodes",
        expect: { maxItems: 1 },
        message: "the compared resolvers disagree on whether the host resolves (got {got}); a SERVFAIL on a validating resolver alone points at DNSSEC",
        severity: "warning",
        fix: "Query each resolver named in the finding and fix what the failing one reports, a broken DNSSEC chain first.",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-5.5",
    },
    "dns/resolver-answers": {
        fact: "site.hosts.*.resolvers.answer-sets",
        expect: { maximum: 1 },
        when: { "site.hosts.*.resolvers.answer-sets": { type: "integer" } },
        message: "the compared resolvers give {got} different answers for the host; geo-DNS does this on purpose, a stale or split view does not",
        severity: "info",
        fix: "If the answers should match, wait out the old TTL or fix the view that differs.",
        docs: "https://www.rfc-editor.org/rfc/rfc2181#section-5.4.1",
    },
    "dns/resolver-validation": {
        fact: "site.hosts.*.resolvers.validated",
        expect: { maxItems: 1 },
        when: { "site.hosts.*.dnssec.signed": true },
        message: "some compared resolvers validate the signed zone and some do not (got {got})",
        severity: "info",
        fix: "Check the DS at the parent and the DNSKEY set against each resolver’s trust anchors.",
        docs: "https://www.rfc-editor.org/rfc/rfc4035#section-4.3",
    },
    "dns/ns-diversity": {
        fact: "site.hosts.*.nameservers.networks",
        expect: { minimum: 2 },
        message: "every name server address sits in one /24 or /48",
        severity: "info",
        docs: "https://www.rfc-editor.org/rfc/rfc2182#section-3.1",
        fix: "Place name servers on addresses in different /24 or /48 networks.",
    },
};

const CORE = ["dns/https-record", "dns/caa", "dns/caa-issuer", "dns/dangling-cname", "dns/dnssec", "dns/dnssec-bogus"];

// Records, CAA, DNSSEC and name servers of every crawled host, asked of the configured resolver.
export default definePlugin({
    name: "dns",
    settings: { type: "object", additionalProperties: false, properties: { compare: { type: "array", items: { type: "string", minLength: 1 }, default: [] } } },
    sites: [addresses, dnssec, nameservers, resolvers, mail],
    presets: {
        dns: { description: "DNS of every crawled host: HTTPS records, CAA, DNSSEC, name servers, dangling CNAMEs", rules: RULES },
        "dns:mail": { description: "Null MX, a deny-all SPF and a DMARC reject policy, for names that send and take no mail", rules: MAIL },
        "dns:core": { description: "HTTPS record, CAA, DNSSEC state and dangling CNAMEs, a handful of queries per host", rules: Object.fromEntries(CORE.map((id) => [id, RULES[id] as RuleSpec])) },
    },
});
