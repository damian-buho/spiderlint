// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { reason } from "../crawl/fetch.ts";
import { pace } from "../crawl/network.ts";
import { clientHello, curve, dhBits, FALLBACK_SCSV, type Client, type Flight, INAPPROPRIATE_FALLBACK, keyShares, type Protocol, readFlight, SSL2_KINDS, sslv2Hello, TLS13_MANDATORY, VERSIONS } from "../crawl/tls-hello.ts";
import { log } from "../logger.ts";
import { GROUPS, SUITES } from "./tls-registry.ts";

// Milliseconds one connection may take to connect and answer a hello.
const EXCHANGE_MS = 8000;
// Connections open to one address at a time.
const SOCKETS = 4;
// Retries of a connection that failed before its hello went out.
const RETRIES = 2;
// Hellos per enumeration, beyond any server’s suite or group count.
const MAX_ROUNDS = 128;
// Bytes read before a flight that never completes is cut off.
const MAX_BYTES = 256 * 1024;

// Protocols up to TLS 1.2, oldest first, each probed with its own ClientHello.
const LEGACY_HELLOS = ["SSLv3", "TLSv1", "TLSv1.1", "TLSv1.2"] as const;
// Every protocol, oldest first, as `protocols` lists them.
const ORDER: Protocol[] = ["SSLv2", ...LEGACY_HELLOS, "TLSv1.3"];
// Versions RFC 8996 and RFC 7568 retire.
const LEGACY = new Set<Protocol>(["SSLv2", "SSLv3", "TLSv1", "TLSv1.1"]);

const MODERN_SUITES = Object.keys(SUITES)
    .map(Number)
    .filter((code) => !SUITES[code]?.includes("_WITH_"));
const CLASSIC_SUITES = Object.keys(SUITES)
    .map(Number)
    .filter((code) => SUITES[code]?.includes("_WITH_"));
// Groups a TLS 1.2 ECDHE suite may use; finite-field ones are left out so a DHE suite shows the server’s own prime.
const CURVES = Object.keys(GROUPS)
    .map(Number)
    .filter((code) => code < 256);
const ALL_GROUPS = Object.keys(GROUPS).map(Number);

// What a suite’s name says about its strength.
export interface Traits {
    // Broken outright: no encryption, no authentication, export grade, RC4, single DES, RC2, or SSLv2.
    isInsecure: boolean;
    // Short of current practice: no forward secrecy, CBC, or a 64-bit block.
    isWeak: boolean;
    isForward: boolean;
    isCbc: boolean;
    isSmallBlock: boolean;
}

export interface Target {
    host: string;
    address: string;
    port: number;
    signal: AbortSignal;
}

export interface ScanFacts {
    protocols: Protocol[];
    legacy: Protocol[];
    ciphers?: string[];
    "ciphers-by-protocol"?: Partial<Record<Protocol, string[]>>;
    "weak-ciphers"?: string[];
    "insecure-ciphers"?: string[];
    "server-order"?: boolean;
    "forward-secrecy"?: "all" | "some" | "none";
    groups?: string[];
    "dh-bits"?: number;
    vulnerabilities?: string[];
    "secure-renegotiation"?: boolean;
    "fallback-scsv"?: boolean;
    compression?: boolean;
    heartbeat?: boolean;
    // DER certificates of the default handshake, leaf first, and its stapled OCSP response.
    certificates?: Buffer[];
    ocsp?: Buffer;
}

// Thrown when a connection failed before its hello went out, which a retry may cure.
class Unconnected extends Error {}

// Connections open per address, and the callers waiting for one of them to close.
const busy = new Map<string, { open: number; waiting: (() => void)[] }>();

// Waits for one of the address’s connection slots; the returned function frees it.
async function acquire(address: string): Promise<() => void> {
    const state = busy.get(address) ?? { open: 0, waiting: [] };
    busy.set(address, state);
    if (state.open < SOCKETS) state.open++;
    else
        await new Promise<void>((resolve) => {
            state.waiting.push(resolve);
        });
    return () => {
        const next = state.waiting.shift();
        if (next) next();
        else if (--state.open === 0) busy.delete(address);
    };
}

// One hello over a fresh connection and whatever the server answered before it closed, went quiet or said all it will.
function once(target: Target, hello: Buffer, client?: Client): Promise<Flight> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: target.address, port: target.port });
        let data = Buffer.alloc(0);
        let isConnected = false;
        let isDone = false;
        const finish = (error?: Error) => {
            if (isDone) return;
            isDone = true;
            clearTimeout(timer);
            target.signal.removeEventListener("abort", abort);
            socket.destroy();
            if (error) reject(error);
            else resolve(readFlight(data, client));
        };
        const abort = () => finish(new Error("aborted"));
        const timer = setTimeout(() => finish(isConnected ? undefined : new Unconnected(`no connection within ${EXCHANGE_MS} ms`)), EXCHANGE_MS);
        target.signal.addEventListener("abort", abort, { once: true });
        socket.once("connect", () => {
            isConnected = true;
            socket.write(hello);
        });
        socket.on("data", (chunk: Buffer) => {
            data = Buffer.concat([data, chunk]);
            if (data.length > MAX_BYTES || readFlight(data, client).complete) finish();
        });
        socket.once("error", (error) => finish(isConnected ? undefined : new Unconnected(reason(error))));
        socket.once("close", () => finish());
    });
}

// One hello under the run’s pace and the address’s socket cap, retried with backoff and jitter while no connection opens.
async function exchange(target: Target, hello: Buffer, client?: Client): Promise<Flight> {
    for (let attempt = 0; ; attempt++) {
        const release = await acquire(target.address);
        let failure: unknown;
        try {
            await pace();
            return await once(target, hello, client);
        } catch (error) {
            failure = error;
        } finally {
            release();
        }
        if (!(failure instanceof Unconnected) || attempt >= RETRIES || target.signal.aborted) throw failure;
        const wait = Math.round(250 * 2 ** attempt * (0.5 + Math.random()));
        log.debug({ address: target.address, port: target.port, attempt, wait, error: reason(failure) }, "tls scan connection retried");
        await sleep(wait, undefined, { signal: target.signal });
    }
}

// Whether `flight` is a handshake at `protocol` on one of the `offered` suites.
function isAccepted(flight: Flight, protocol: Protocol, offered: number[]): boolean {
    return flight.version === VERSIONS[protocol as keyof typeof VERSIONS] && flight.suite !== undefined && offered.includes(flight.suite);
}

// The suites a protocol accepts, each found by offering the rest until the server refuses; `isFull` stops at the first.
async function enumerate(target: Target, protocol: Exclude<Protocol, "SSLv2">, suites: number[], isFull: boolean): Promise<Flight[]> {
    const accepted: Flight[] = [];
    const isModern = protocol === "TLSv1.3";
    for (let offered = suites, round = 0; offered.length > 0 && round < MAX_ROUNDS; round++) {
        const flight = await exchange(target, clientHello({ protocol, suites: offered, host: target.host, groups: isModern ? ALL_GROUPS : CURVES, ...(isModern ? { shares: [] } : { compression: true }) }));
        const isTaken = isAccepted(flight, protocol, offered);
        log.debug({ host: target.host, protocol, round, offered: offered.length, suite: flight.suite, version: flight.version, alert: flight.alert, error: flight.error, isTaken }, "tls suite offered");
        if (!isTaken) break;
        accepted.push(flight);
        if (!isFull) break;
        offered = offered.filter((suite) => suite !== flight.suite);
    }
    return accepted;
}

// The group a TLS 1.3 HelloRetryRequest or an ECDHE ServerKeyExchange names.
function namedGroup(flight: Flight, isModern: boolean): number | undefined {
    return isModern ? flight.retry && flight.group : flight.keyExchange && curve(flight.keyExchange);
}

// Groups the server takes, each named in a TLS 1.3 HelloRetryRequest or a ServerKeyExchange, offering the rest until it refuses.
async function enumerateGroups(target: Target, protocol: Exclude<Protocol, "SSLv2">, suites: number[], groups: number[]): Promise<number[]> {
    const found: number[] = [];
    const isModern = protocol === "TLSv1.3";
    for (let offered = groups, round = 0; offered.length > 0 && round < MAX_ROUNDS; round++) {
        const flight = await exchange(target, clientHello({ protocol, suites, host: target.host, groups: offered, ...(isModern && { shares: [] }) }));
        const group = namedGroup(flight, isModern);
        log.debug({ host: target.host, protocol, round, offered: offered.length, group, alert: flight.alert }, "tls group offered");
        if (group === undefined || !offered.includes(group)) break;
        found.push(group);
        offered = offered.filter((entry) => entry !== group);
    }
    return found;
}

// Whether the server picks by its own order: the same suite when the accepted ones are offered forwards and reversed.
async function serverOrder(target: Target, protocol: (typeof LEGACY_HELLOS)[number], suites: number[]): Promise<boolean | undefined> {
    if (suites.length < 2) return;
    const [forward, reverse] = [await exchange(target, clientHello({ protocol, suites, host: target.host, groups: CURVES })), await exchange(target, clientHello({ protocol, suites: suites.toReversed(), host: target.host, groups: CURVES }))];
    log.debug({ host: target.host, protocol, forward: forward.suite, reverse: reverse.suite }, "tls server order tried");
    return forward.suite === undefined || reverse.suite === undefined ? undefined : forward.suite === reverse.suite;
}

// Whether a retry below the best version is refused as a needless fallback (RFC 7507).
async function fallback(target: Target, protocol: (typeof LEGACY_HELLOS)[number], suites: number[]): Promise<boolean | undefined> {
    const flight = await exchange(target, clientHello({ protocol, suites: [...suites, FALLBACK_SCSV], host: target.host, groups: CURVES }));
    log.debug({ host: target.host, protocol, alert: flight.alert, suite: flight.suite }, "tls fallback tried");
    if (flight.alert === INAPPROPRIATE_FALLBACK) return true;
    if (flight.suite !== undefined) return false;
}

// Whether SSLv2 answers, with the cipher kinds it offers.
async function sslv2(target: Target): Promise<number[]> {
    const flight = await exchange(target, sslv2Hello());
    log.debug({ host: target.host, kinds: flight.kinds, alert: flight.alert }, "sslv2 tried");
    return flight.kinds ?? [];
}

// The certificates and stapled OCSP response of a TLS 1.3 handshake, decrypted up to its Certificate.
async function modernCertificates(target: Target): Promise<Flight> {
    const keys = keyShares();
    const hello = clientHello({ protocol: "TLSv1.3", suites: [TLS13_MANDATORY], host: target.host, groups: keys.shares.map((share) => share.group), shares: keys.shares });
    const flight = await exchange(target, hello, keys.client(hello));
    log.debug({ host: target.host, certificates: flight.certificates?.length, ocsp: flight.ocsp !== undefined, retry: flight.retry, error: flight.error }, "tls 1.3 certificates read");
    return flight;
}

// What a suite’s name says about its strength.
export function traits(name: string): Traits {
    const isLegacy = name.startsWith("SSL_CK_");
    const isModern = !isLegacy && !name.includes("_WITH_");
    const isNull = /_WITH_NULL_/.test(name) || /^TLS_SHA\d+_SHA\d+$/.test(name);
    const isBroken = isLegacy || isNull || /_anon_|EXPORT|_RC4_|_RC2_|(?:^|_)DES(?:40)?_CBC_/.test(name);
    const isForward = isModern || /^TLS_(?:EC)?DH(?:E_|_anon_)/.test(name);
    const isCbc = name.includes("_CBC");
    const isSmallBlock = /3DES|IDEA|(?:^|_)DES(?:40)?_|RC2|_28147_/.test(name);
    return { isInsecure: isBroken, isWeak: !isBroken && (!isForward || isCbc || isSmallBlock), isForward, isCbc, isSmallBlock };
}

// The attacks negotiation alone shows the server open to.
function vulnerabilities(byProtocol: Partial<Record<Protocol, string[]>>, all: string[], bits: number | undefined, isCompressed: boolean): string[] {
    const found = [
        (byProtocol.SSLv3 ?? []).some((name) => traits(name).isCbc) && "poodle",
        (byProtocol.TLSv1 ?? []).some((name) => traits(name).isCbc) && "beast",
        all.some((name) => traits(name).isSmallBlock) && "sweet32",
        all.some((name) => name.startsWith("TLS_RSA_EXPORT")) && "freak",
        (all.some((name) => /_DHE?_(?:RSA|DSS|anon)_EXPORT/.test(name)) || (bits !== undefined && bits < 1024)) && "logjam",
        all.some((name) => /_RC4_/.test(name)) && "rc4",
        (byProtocol.SSLv2 ?? []).length > 0 && "drown",
        isCompressed && "crime",
    ];
    return found.filter((entry): entry is string => typeof entry === "string");
}

// Names of suite codes, deduplicated in order.
function names(codes: number[]): string[] {
    return [...new Set(codes.map((code) => SUITES[code] ?? `0x${code.toString(16).padStart(4, "0")}`))];
}

// Protocols, suites, groups and negotiation-level weaknesses of one origin, from hand-built hellos; `isFull` is false for one hello per protocol.
export async function scan(target: Target, isFull: boolean): Promise<ScanFacts> {
    const [kinds, classic, modern] = await Promise.all([sslv2(target), Promise.all(LEGACY_HELLOS.map((protocol) => enumerate(target, protocol, CLASSIC_SUITES, isFull))), enumerate(target, "TLSv1.3", MODERN_SUITES, isFull)]);
    const flights = new Map<Protocol, Flight[]>([...LEGACY_HELLOS.map((protocol, index) => [protocol, classic[index] ?? []] as const), ["TLSv1.3", modern]]);
    const isSupported = (protocol: Protocol) => (protocol === "SSLv2" ? kinds : (flights.get(protocol) ?? [])).length > 0;
    const protocols = ORDER.filter((protocol) => isSupported(protocol));
    const best = LEGACY_HELLOS.findLast((protocol) => isSupported(protocol));
    const bestFlights = best ? (flights.get(best) ?? []) : [];
    const [first] = bestFlights;
    const hasModern = modern.length > 0;
    const certified = hasModern ? await modernCertificates(target) : undefined;
    const supported = LEGACY_HELLOS.filter((protocol) => protocols.includes(protocol));
    const fallen = hasModern ? supported.at(-1) : supported.at(-2);
    const legacyFlights = classic.flat();
    const isCompressed = legacyFlights.some((flight) => flight.compression === 1);
    const facts: ScanFacts = {
        protocols,
        legacy: protocols.filter((protocol) => LEGACY.has(protocol)),
        ...(first && { "secure-renegotiation": first.extensions?.includes(0xff_01) ?? false, heartbeat: first.extensions?.includes(15) ?? false }),
        ...(legacyFlights.length > 0 && { compression: isCompressed }),
    };
    if (fallen) {
        const scsv = await fallback(target, fallen, CLASSIC_SUITES);
        if (scsv !== undefined) facts["fallback-scsv"] = scsv;
    }
    const withCertificates = certified?.certificates?.length ? certified : [...bestFlights, ...legacyFlights].find((flight) => (flight.certificates?.length ?? 0) > 0);
    if (withCertificates?.certificates) facts.certificates = withCertificates.certificates;
    if (withCertificates?.ocsp) facts.ocsp = withCertificates.ocsp;
    log.debug({ host: target.host, protocols, best, isFull, certificates: facts.certificates?.length }, "tls protocols scanned");
    if (!isFull) return facts;
    const byProtocol: Partial<Record<Protocol, string[]>> = Object.fromEntries(protocols.map((protocol) => [protocol, protocol === "SSLv2" ? kinds.map((kind) => SSL2_KINDS[kind] ?? `0x${kind.toString(16)}`) : names((flights.get(protocol) ?? []).map((flight) => flight.suite ?? 0))]));
    const all = [...new Set(ORDER.toReversed().flatMap((protocol) => byProtocol[protocol] ?? []))];
    const dhe = legacyFlights.filter((flight) => flight.keyExchange && /^TLS_DH(?:E_(?:RSA|DSS)|_anon)_/.test(SUITES[flight.suite ?? 0] ?? ""));
    const bits = dhe.length > 0 ? Math.min(...dhe.map((flight) => dhBits(flight.keyExchange as Buffer))) : undefined;
    const ecdhe = bestFlights.map((flight) => flight.suite ?? 0).filter((code) => /^TLS_ECDHE_(?:RSA|ECDSA)_/.test(SUITES[code] ?? ""));
    const groups = [
        ...(hasModern
            ? await enumerateGroups(
                  target,
                  "TLSv1.3",
                  modern.map((flight) => flight.suite ?? 0),
                  ALL_GROUPS,
              )
            : []),
        ...(best && ecdhe.length > 0 ? await enumerateGroups(target, best, ecdhe, CURVES) : []),
    ];
    const order = best
        ? await serverOrder(
              target,
              best,
              bestFlights.map((flight) => flight.suite ?? 0),
          )
        : undefined;
    const forward = all.map((name) => traits(name).isForward);
    log.debug({ host: target.host, ciphers: all.length, groups: groups.length, bits, order }, "tls suites scanned");
    return {
        ...facts,
        ciphers: all,
        "ciphers-by-protocol": byProtocol,
        "weak-ciphers": all.filter((name) => traits(name).isWeak),
        "insecure-ciphers": all.filter((name) => traits(name).isInsecure),
        ...(order !== undefined && { "server-order": order }),
        ...(all.length > 0 && { "forward-secrecy": forward.every(Boolean) ? "all" : forward.some(Boolean) ? "some" : "none" }),
        groups: [...new Set(groups.map((group) => GROUPS[group] ?? String(group)))],
        ...(bits !== undefined && { "dh-bits": bits }),
        vulnerabilities: vulnerabilities(byProtocol, all, bits, isCompressed),
    };
}
