// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { connect, isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import dnsPacket, { type Answer, type Packet } from "dns-packet";
import type { Bucket } from "../cache/index.ts";
import { ConfigError } from "../config/index.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";

const ATTEMPTS = 2;
const TIMEOUT_MS = 3000;
const PAYLOAD = 1232;

export interface Server {
    address: string;
    port: number;
}

export interface QueryOptions {
    // An authoritative server asked directly, recursion off; the configured resolver otherwise.
    server?: string;
    // Sets `CD`, so a validating resolver answers what it would reject as bogus.
    checkingDisabled?: boolean;
    signal?: AbortSignal;
}

export interface Reply {
    server: string;
    rcode: string;
    aa: boolean;
    ad: boolean;
    answers: Answer[];
    authorities: Answer[];
}

// What a site extractor may ask of DNS: one query at a time, and whether the resolver validates.
export interface DnsClient {
    query(name: string, type: string, options?: QueryOptions): Promise<Reply>;
    validating(): Promise<boolean>;
    // Whether `server` may name an authoritative server; off where a public instance must not be steered.
    readonly canQueryDirectly: boolean;
}

// A client refusing every query, for a proxied run whose queries would bypass the proxy.
export const PROXIED_DNS: DnsClient = {
    canQueryDirectly: false,
    query: async (name) => {
        throw new Error(`DNS query for ${name} would bypass the proxy`);
    },
    validating: async () => false,
};

// The wire form of a cached reply, fresh until `expires`.
export interface StoredReply {
    expires: string;
    packet: string;
}

// `address[:port]`, an IPv6 address bracketed when it carries a port.
function server(entry: string): Server {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    const [address, port] = bracketed ? [bracketed[1] as string, bracketed[2]] : isIP(entry) === 6 ? [entry, undefined] : (entry.split(":") as [string, string?]);
    const number = port === undefined ? 53 : Number(port);
    if (isIP(address.split("%", 1)[0] as string) === 0 || !Number.isSafeInteger(number) || number < 1 || number > 65_535) throw new ConfigError(`resolver: invalid server ${entry} (expected address[:port])`);
    return { address, port: number };
}

// `system`, or a comma list of `address[:port]`; anything else is a config error.
export function parseResolver(raw: string): string {
    const value = raw.trim();
    if (value !== "system") for (const entry of value.split(",")) server(entry.trim());
    return value;
}

// The `nameserver` lines of `/etc/resolv.conf`.
function systemServers(): Server[] {
    let text = "";
    try {
        text = readFileSync("/etc/resolv.conf", "utf8");
    } catch (error) {
        log.warn({ error: reason(error) }, "resolv.conf unreadable");
    }
    const servers = text.matchAll(/^\s*nameserver\s+(\S+)/gm).map((match) => ({ address: match[1] as string, port: 53 })).toArray();
    log.debug({ servers: servers.map((entry) => entry.address) }, "system resolvers read");
    return servers;
}

// The servers a resolver setting names.
export function servers(resolver: string): Server[] {
    return resolver === "system" ? systemServers() : resolver.split(",").map((entry) => server(entry.trim()));
}

function label({ address, port }: Server): string {
    return isIP(address.split("%", 1)[0] as string) === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

// One query over UDP, answered only by a reply carrying its ID.
function overUdp(target: Server, message: Buffer, id: number, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = createSocket(isIP(target.address.split("%", 1)[0] as string) === 6 ? "udp6" : "udp4");
        const done = (error?: Error, reply?: Buffer) => {
            socket.close();
            signal.removeEventListener("abort", abort);
            if (error) reject(error);
            else resolve(reply as Buffer);
        };
        const abort = () => done(new Error(`no answer from ${label(target)} in ${TIMEOUT_MS} ms`));
        signal.addEventListener("abort", abort, { once: true });
        socket.on("error", (error) => done(error));
        socket.on("message", (reply) => {
            if (reply.length >= 2 && reply.readUInt16BE(0) === id) done(undefined, reply);
        });
        socket.send(message, target.port, target.address);
    });
}

// One query over TCP, each message prefixed by its length.
function overTcp(target: Server, message: Buffer, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: target.address, port: target.port, signal });
        const chunks: Buffer[] = [];
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(message.length);
        socket.on("connect", () => socket.end(Buffer.concat([prefix, message])));
        socket.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
        });
        socket.on("error", reject);
        socket.on("end", () => {
            const reply = Buffer.concat(chunks);
            if (reply.length < 2 || reply.length < 2 + reply.readUInt16BE(0)) reject(new Error(`short TCP answer from ${label(target)}`));
            else resolve(reply.subarray(2, 2 + reply.readUInt16BE(0)));
        });
    });
}

// Encodes one question with `DO` set and `RD` unless the server is asked directly.
function encode(name: string, type: string, options: QueryOptions): { id: number; message: Buffer } {
    const id = randomInt(65_536);
    const flags = (options.server === undefined ? dnsPacket.RECURSION_DESIRED : 0) | dnsPacket.AUTHENTIC_DATA | (options.checkingDisabled ? dnsPacket.CHECKING_DISABLED : 0);
    const message = dnsPacket.encode({ type: "query", id, flags, questions: [{ type: type as "A", name, class: "IN" }], additionals: [{ type: "OPT", name: ".", udpPayloadSize: PAYLOAD, flags: dnsPacket.DNSSEC_OK }] } as Packet);
    return { id, message };
}

// One exchange with one server: UDP, then TCP when the answer is truncated.
async function exchange(target: Server, name: string, type: string, options: QueryOptions, outer: AbortSignal): Promise<Buffer> {
    const { id, message } = encode(name, type, options);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(TIMEOUT_MS)]);
    const reply = await overUdp(target, message, id, signal);
    if ((reply.readUInt16BE(2) & 0x02_00) === 0) return reply;
    log.debug({ name, type, server: label(target) }, "dns answer truncated, retrying over TCP");
    return overTcp(target, message, signal);
}

// Decodes the wire answer the extractors read.
function decode(target: string, wire: Buffer): Reply {
    const packet = dnsPacket.decode(wire);
    return { server: target, rcode: (packet as { rcode?: string }).rcode ?? "NOERROR", aa: packet.flag_aa ?? false, ad: packet.flag_ad ?? false, answers: packet.answers ?? [], authorities: packet.authorities ?? [] };
}

// The smallest TTL in an answer, floored at `floor` seconds.
function lifetime(reply: Reply, floor: number): number {
    const ttls = [...reply.answers, ...reply.authorities].flatMap((record) => ("ttl" in record && record.ttl !== undefined ? [record.ttl] : []));
    return ttls.length === 0 ? floor : Math.max(floor, Math.min(...ttls));
}

// Whether the resolver sets `AD` on the signed root SOA; warns when it does not.
async function isValidating(client: DnsClient, resolver: string): Promise<boolean> {
    try {
        const { ad } = await client.query(".", "SOA");
        log.info({ resolver, validating: ad }, "resolver validation checked");
        if (!ad) log.warn({ resolver }, "resolver does not validate DNSSEC; dns/dnssec-bogus skipped");
        return ad;
    } catch (error) {
        log.warn({ resolver, error: reason(error) }, "resolver unreachable; dns/dnssec-bogus skipped");
        return false;
    }
}

// A resolver over the configured servers, caching every answer for its record TTL.
export function dnsClient(resolver: string, bucket: Bucket<StoredReply>, canQueryDirectly: boolean, directPort = 53): DnsClient {
    const configured = servers(resolver);
    let validation: Promise<boolean> | undefined;
    const client: DnsClient = {
        canQueryDirectly,
        async query(name, type, options = {}) {
            if (!canQueryDirectly && options.server !== undefined) throw new Error(`direct query to ${options.server} refused`);
            const targets = options.server === undefined ? configured : [{ address: options.server, port: directPort }];
            if (targets.length === 0) throw new Error("no resolver configured");
            const signal = options.signal ?? new AbortController().signal;
            signal.throwIfAborted();
            const key = `${targets.map((target) => label(target)).join(",")}\t${name}\t${type}\t${options.checkingDisabled ? "cd" : ""}`;
            const entry = await bucket.get(key);
            if (entry && Date.parse(entry.value.expires) > Date.now()) return decode(targets[0] ? label(targets[0]) : "", Buffer.from(entry.value.packet, "base64"));
            let failure: unknown;
            for (const target of targets) {
                for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
                    try {
                        const wire = await exchange(target, name, type, options, signal);
                        const reply = decode(label(target), wire);
                        log.debug({ name, type, server: label(target), rcode: reply.rcode, answers: reply.answers.length, ad: reply.ad, attempt }, "dns answered");
                        await bucket.set(key, { expires: new Date(Date.now() + lifetime(reply, bucket.ttlSeconds) * 1000).toISOString(), packet: wire.toString("base64") });
                        return reply;
                    } catch (error) {
                        failure = error;
                        log.debug({ name, type, server: label(target), attempt, error: reason(error) }, "dns query failed");
                        if (signal.aborted) throw error;
                        await sleep(100 * 2 ** attempt + Math.random() * 100);
                    }
                }
            }
            throw failure instanceof Error ? failure : new Error(String(failure));
        },
        // The root zone is signed, so a validating resolver sets `AD` on its SOA; warns once when it does not.
        validating() {
            validation ??= isValidating(client, resolver);
            return validation;
        },
    };
    return client;
}
