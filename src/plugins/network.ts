// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { isIP } from "node:net";
import type { MxData } from "dns-packet";
import type { DnsClient } from "../crawl/dns.ts";
import { reason } from "../crawl/fetch.ts";
import { log } from "../logger.ts";
import type { RuleSpec } from "../rules/types.ts";
import { isSpecialUse, once, records, texts, warnOnce, zoneOf } from "./dns.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

const RIPESTAT = "https://stat.ripe.net/data/rpki-validation/data.json";

// RIPEstat’s route status to RFC 6811’s three states.
const STATES: Record<string, string> = { valid: "valid", invalid: "invalid", invalid_asn: "invalid", invalid_length: "invalid", unknown: "not-found" };

// `org.spiderlint.network`: `rpki: false` never asks RIPEstat.
export interface NetworkSettings {
    rpki: boolean;
}

// Who routes one address; `registry-country` is where the block is registered, not where the server stands.
interface Identity {
    address: string;
    name?: string;
    asn?: number;
    prefix?: string;
    holder?: string;
    "registry-country"?: string;
    ptr: string[];
    fcrdns: boolean;
    rpki?: string;
}

// The 32 hex nibbles of an IPv6 address.
function nibbles(address: string): string {
    const [head = "", tail = ""] = address.split("::", 2);
    const [left, right] = [head ? head.split(":") : [], tail ? tail.split(":") : []];
    const groups = address.includes("::") ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right] : left;
    return groups
        .map((group) => group.padStart(4, "0"))
        .join("")
        .toLowerCase();
}

// The address’s labels in reverse order, octets for IPv4 and nibbles for IPv6.
function reversed(address: string): string {
    return (isIP(address) === 4 ? address.split(".") : [...nibbles(address)]).toReversed().join(".");
}

function isSameAddress(a: string, b: string): boolean {
    return isIP(a) === 6 && isIP(b) === 6 ? nibbles(a) === nibbles(b) : a === b;
}

// The A and AAAA addresses of `name`, IPv4 first.
async function addressesOf(name: string, dns: DnsClient): Promise<string[]> {
    const [a, aaaa] = await Promise.all([dns.query(name, "A"), dns.query(name, "AAAA")]);
    return [...records<string>(a, "A"), ...records<string>(aaaa, "AAAA")].map(({ data }) => data);
}

// The PTR names of `address`, and whether one resolves back to it (forward-confirmed reverse DNS).
async function reverse(address: string, dns: DnsClient): Promise<{ ptr: string[]; fcrdns: boolean }> {
    const ptr = records<string>(await dns.query(`${reversed(address)}.${isIP(address) === 4 ? "in-addr.arpa" : "ip6.arpa"}`, "PTR"), "PTR").map(({ data }) => data.replace(/\.$/, ""));
    const forward = await Promise.all(ptr.map(async (name) => records<string>(await dns.query(name, isIP(address) === 4 ? "A" : "AAAA"), isIP(address) === 4 ? "A" : "AAAA")));
    const fcrdns = forward.flat().some(({ data }) => isSameAddress(data, address));
    log.debug({ address, ptr, fcrdns }, "reverse dns read");
    return { ptr, fcrdns };
}

// The `|`-separated fields of the first TXT answer to `name` from Team Cymru; empty when the name is not routed.
async function cymru(name: string, dns: DnsClient): Promise<string[]> {
    const reply = await dns.query(name, "TXT");
    if (!["NOERROR", "NXDOMAIN"].includes(reply.rcode)) throw new Error(`${name} answered ${reply.rcode}`);
    return (texts(reply)[0] ?? "").split("|").map((field) => field.trim());
}

// The holder name Team Cymru records for `asn`.
async function holderOf(asn: number, dns: DnsClient): Promise<string | undefined> {
    const fields = await cymru(`AS${asn}.asn.cymru.com`, dns);
    return fields[4] || undefined;
}

// RIPEstat’s RPKI state of the route `asn` announces `prefix` with.
async function validityOf(asn: number, prefix: string, context: SiteContext): Promise<string | undefined> {
    const answer = await context.delegated(`${RIPESTAT}?resource=AS${asn}&prefix=${encodeURIComponent(prefix)}&sourceapp=spiderlint`);
    if (answer.status !== 200) throw new Error(`RIPEstat answered ${answer.status}`);
    const status = (JSON.parse(answer.body) as { data?: { status?: string } }).data?.status ?? "";
    log.debug({ asn, prefix, status }, "rpki validity read");
    return STATES[status];
}

// The mail exchangers `host` names, a null MX left out.
async function exchangesOf(host: string, dns: DnsClient): Promise<string[]> {
    const reply = await dns.query(host, "MX");
    return records<MxData>(reply, "MX")
        .map(({ data }) => data.exchange)
        .filter((exchange) => exchange !== "." && exchange !== "");
}

// The name servers of `zone`.
async function serversOf(zone: string, dns: DnsClient): Promise<string[]> {
    const reply = await dns.query(zone, "NS");
    return records<string>(reply, "NS").map(({ data }) => data);
}

// Cymru and RIPEstat lookups for one subject, each asked once; a failing source is warned once per run and skipped.
function identifier(context: SiteContext): { identify(address: string, name?: string): Promise<Identity>; answered(): boolean } {
    const { rpki: isRpki = true } = (context.settings ?? {}) as Partial<NetworkSettings>;
    const holders = new Map<number, Promise<string | undefined>>();
    const routes = new Map<string, Promise<string | undefined>>();
    let isCymruDown = false;
    const route = async (address: string): Promise<Omit<Identity, "address" | "ptr" | "fcrdns">> => {
        if (isCymruDown) return {};
        try {
            const [asns = "", prefix = "", country = ""] = await cymru(`${reversed(address)}.${isIP(address) === 4 ? "origin" : "origin6"}.asn.cymru.com`, context.dns);
            const asn = Number(asns.split(/\s+/, 1)[0]);
            log.debug({ address, asn, prefix, country }, "route origin read");
            if (!prefix || !Number.isSafeInteger(asn) || asn <= 0) return {};
            const holder = await once(holders, asn, () => holderOf(asn, context.dns));
            return { asn, prefix, ...(holder && { holder }), ...(country && { "registry-country": country }) };
        } catch (error) {
            isCymruDown = true;
            warnOnce(context.dns, "Team Cymru", { address, error: reason(error) });
            return {};
        }
    };
    const valid = async (asn: number | undefined, prefix: string | undefined): Promise<string | undefined> => {
        log.debug({ asn, prefix, isRpki }, "rpki lookup decided");
        if (!isRpki || asn === undefined || !prefix) return;
        try {
            return await once(routes, `${asn} ${prefix}`, () => validityOf(asn, prefix, context));
        } catch (error) {
            warnOnce(context.dns, "RIPEstat", { asn, prefix, error: reason(error) });
        }
    };
    return {
        async identify(address, name) {
            const [origin, names] = await Promise.all([route(address), reverse(address, context.dns)]);
            const state = await valid(origin.asn, origin.prefix);
            return { address, ...(name && { name }), ...origin, ...names, ...(state && { rpki: state }) };
        },
        answered: () => !isCymruDown,
    };
}

// ASN, holder, registry country, RPKI state and reverse DNS of the host’s addresses, its MX exchanges’ and its name servers’.
const network: SiteExtractor = {
    id: "network",
    per: "host",
    cached: false,
    resolves: true,
    async extract(host, context) {
        if (isSpecialUse(host)) return;
        const isLiteral = isIP(host) !== 0;
        const zone = isLiteral ? undefined : await zoneOf(host, context.dns);
        if (!isLiteral && !zone) return;
        const [web, exchanges, servers] = await Promise.all([isLiteral ? [host] : addressesOf(host, context.dns), isLiteral ? [] : exchangesOf(host, context.dns), zone ? serversOf(zone, context.dns) : []]);
        const { identify, answered } = identifier(context);
        const named = async (names: string[]) => {
            const addresses = await Promise.all(
                names.map(async (name) => {
                    const found = await addressesOf(name, context.dns);
                    return found.map((address) => ({ address, name }));
                }),
            );
            return Promise.all(addresses.flat().map(({ address, name }) => identify(address, name)));
        };
        const [webIds, mailIds, serverIds] = await Promise.all([Promise.all(web.map((address) => identify(address))), named(exchanges), named(servers)]);
        const asns = answered() ? [...new Set([...webIds, ...serverIds].flatMap((entry) => (entry.asn === undefined ? [] : [`AS${entry.asn}`])))].toSorted((a, b) => a.localeCompare(b)) : undefined;
        log.debug({ host, zone, web: webIds.length, mail: mailIds.length, nameservers: serverIds.length, asns }, "network identity read");
        return { web: webIds, mail: mailIds, nameservers: serverIds, ...(asns && { asns }) };
    },
};

const RULES: Record<string, RuleSpec> = {
    "network/rpki-invalid": {
        fact: "site.hosts.*.network.web",
        expect: { items: { properties: { rpki: { not: { const: "invalid" } } } } },
        message: "an address sits in a route RPKI marks invalid, so networks that drop invalid routes cannot reach the site",
        severity: "error",
        score: 9,
        docs: "https://www.rfc-editor.org/rfc/rfc6811",
        fix: "Have the hosting provider publish a ROA naming the origin AS and prefix length the route is announced with.",
    },
    "network/rpki-not-found": {
        fact: "site.hosts.*.network.web",
        expect: { items: { properties: { rpki: { not: { const: "not-found" } } } } },
        message: "an address sits in a prefix no ROA covers, so a hijack of its route cannot be told apart",
        severity: "hint",
        score: 0.7,
        docs: "https://www.rfc-editor.org/rfc/rfc6480",
        fix: "Ask the hosting provider to publish a ROA for the prefix that announces the address.",
    },
    "network/mail-fcrdns": {
        fact: "site.hosts.*.network.mail",
        expect: { items: { properties: { fcrdns: { const: true } } } },
        message: "a mail exchanger address has no PTR, or its PTR does not resolve back to it, so large mailbox providers refuse its mail",
        severity: "warning",
        score: 5.8,
        docs: "https://www.rfc-editor.org/rfc/rfc1912#section-2.1",
        fix: "Set the PTR of each mail exchanger address to a name whose A or AAAA record is that address.",
    },
    "network/single-asn": {
        fact: "site.hosts.*.network.asns",
        expect: { not: { minItems: 1, maxItems: 1 } },
        when: { "site.hosts.*.network.asns": { type: "array" } },
        message: "the host and every name server sit in one autonomous system, so one network outage takes the site and its DNS down together (got {got})",
        severity: "hint",
        score: 0.6,
        docs: "https://www.rfc-editor.org/rfc/rfc2182#section-3.1",
        fix: "Serve the zone from at least one name server in a second autonomous system.",
    },
};

// Who routes every crawled host’s addresses, through Team Cymru’s DNS interface and RIPEstat.
export default definePlugin({
    name: "network",
    settings: { type: "object", additionalProperties: false, properties: { rpki: { type: "boolean", default: true } } },
    sites: [network],
    presets: { network: { description: "ASN, RPKI route validity and reverse DNS of every crawled host, its mail exchangers and name servers", rules: RULES } },
});
