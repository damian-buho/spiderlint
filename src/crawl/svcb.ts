// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// One SVCB or HTTPS record (RFC 9460); `ech` records presence, not the config list.
export interface Svcb {
    priority: number;
    target: string;
    mandatory?: string[];
    alpn?: string[];
    "no-default-alpn"?: true;
    port?: number;
    ipv4hint?: string[];
    ech?: true;
    ipv6hint?: string[];
    unknown?: number[];
}

const KEYS = ["mandatory", "alpn", "no-default-alpn", "port", "ipv4hint", "ech", "ipv6hint"];

// An uncompressed domain name at `offset`, as §2.2 requires, and the offset past it.
function name(data: Buffer, offset: number): [string, number] {
    const labels: string[] = [];
    for (let length = data.readUInt8(offset); length > 0; length = data.readUInt8(offset)) {
        if (length > 63) throw new Error(`SVCB target label length ${length} is a compression pointer`);
        labels.push(data.toString("latin1", offset + 1, offset + 1 + length));
        offset += 1 + length;
    }
    return [labels.length === 0 ? "." : labels.join("."), offset + 1];
}

// `width`-byte chunks of `value`, each rendered by `render`.
function chunks(value: Buffer, width: number, render: (chunk: Buffer) => string): string[] {
    if (value.length % width !== 0) throw new Error(`SVCB address hint of ${value.length} bytes`);
    return Array.from({ length: value.length / width }, (_, index) => render(value.subarray(index * width, (index + 1) * width)));
}

// Length-prefixed strings, the wire form of `alpn`.
function strings(value: Buffer): string[] {
    const out: string[] = [];
    for (let offset = 0; offset < value.length; offset += 1 + value.readUInt8(offset)) out.push(value.toString("latin1", offset + 1, offset + 1 + value.readUInt8(offset)));
    return out;
}

// The RFC 5952 text form of a 16-byte IPv6 address, as the URL parser canonicalises it.
function ipv6(bytes: Buffer): string {
    const groups = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(":");
    return new URL(`http://[${groups}]/`).hostname.slice(1, -1);
}

// Each known SvcParamKey’s value, by key number (RFC 9460 §14.3.2).
const DECODERS: Record<number, (value: Buffer) => Partial<Svcb>> = {
    0: (value) => ({ mandatory: Array.from({ length: value.length / 2 }, (_, index) => KEYS[value.readUInt16BE(index * 2)] ?? `key${value.readUInt16BE(index * 2)}`) }),
    1: (value) => ({ alpn: strings(value) }),
    2: () => ({ "no-default-alpn": true }),
    3: (value) => ({ port: value.readUInt16BE(0) }),
    4: (value) => ({ ipv4hint: chunks(value, 4, (bytes) => [...bytes].join(".")) }),
    5: () => ({ ech: true }),
    6: (value) => ({ ipv6hint: chunks(value, 16, ipv6) }),
};

// The RDATA of a type 64 or 65 record: priority, target, then key-ordered parameters.
export function parseSvcb(data: Buffer): Svcb {
    const [target, start] = name(data, 2);
    const record: Svcb = { priority: data.readUInt16BE(0), target };
    for (let offset = start; offset < data.length; ) {
        const key = data.readUInt16BE(offset);
        const value = data.subarray(offset + 4, offset + 4 + data.readUInt16BE(offset + 2));
        offset += 4 + value.length;
        const decode = DECODERS[key];
        if (decode) Object.assign(record, decode(value));
        else (record.unknown ??= []).push(key);
    }
    return record;
}
