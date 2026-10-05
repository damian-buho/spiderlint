// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import dns, { type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { log } from "../logger.ts";

// Loopback, private, link-local, CGNAT, unspecified, unique-local and cloud metadata ranges.
const PRIVATE = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
] as const)
    PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
] as const)
    PRIVATE.addSubnet(network, prefix, "ipv6");

// An address no public probe may reach; an IPv4-mapped IPv6 address is judged as its IPv4 form.
export function isPrivate(address: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
    return mapped ? PRIVATE.check(mapped, "ipv4") : PRIVATE.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// A refused address, named so the log and the fact say why.
export class PrivateAddress extends Error {
    readonly code = "EPRIVATE";
}

// The address a raw socket to `hostname` may connect to, through the run’s lookup; a private one is refused unless allowed.
export async function connectable(hostname: string, isPrivateAllowed: boolean): Promise<string> {
    const address = isIP(hostname) === 0 ? await new Promise<string>((resolve, reject) => dns.lookup(hostname, (error, found) => (error ? reject(error) : resolve(found)))) : hostname;
    log.debug({ hostname, address, isPrivateAllowed }, "socket address resolved");
    if (!isPrivateAllowed && isPrivate(address)) throw new PrivateAddress(`${hostname} resolves to private address ${address}`);
    return address;
}

// `lookup` failing when any answer is private, so the socket connects only to an address it checked.
export function guarding(lookup: LookupFunction): LookupFunction {
    return (hostname, options, callback) => {
        lookup(hostname, { ...(options as LookupOptions), all: true }, (error, found) => {
            if (error) return callback(error, "", 0);
            const addresses = found as LookupAddress[];
            const refused = addresses.find((answer) => isPrivate(answer.address));
            log.debug({ hostname, addresses: addresses.map((answer) => answer.address), refused: refused?.address }, "address checked");
            if (refused) return callback(new PrivateAddress(`${hostname} resolves to private address ${refused.address}`), "", 0);
            const [first] = addresses;
            // eslint-disable-next-line unicorn/no-null -- the lookup callback contract types a success as a null error
            callback(null, (options as LookupOptions).all ? addresses : (first?.address ?? ""), first?.family ?? 0);
        });
    };
}

// The system lookup, guarded.
export const guardedLookup: LookupFunction = guarding((hostname, options, callback) => (dns.lookup as LookupFunction)(hostname, options, callback));

// Throws for a URL whose host is a private address literal, which no lookup ever sees.
export function refuseLiteral(url: string | URL, isPrivateAllowed: boolean): void {
    const host = new URL(url).hostname.replaceAll(/^\[|\]$/g, "");
    if (isPrivateAllowed || isIP(host) === 0 || !isPrivate(host)) return;
    log.warn({ host, url: String(url) }, "private address literal refused");
    throw new PrivateAddress(`${host} is a private address`);
}
