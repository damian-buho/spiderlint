// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, unwatchFile, watchFile } from "node:fs";
import { BlockList, isIP } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { parseDuration } from "../cache/index.ts";
import { ConfigError } from "../config/index.ts";
import { describe, validateSubtree } from "../config/schema.ts";
import { log } from "../logger.ts";
import { PROVIDERS } from "./providers.ts";

export const DEFAULT_PATH = "/etc/spiderlint/server.yaml";
const WATCH_MS = 5000;

// Caps a policy lays over a scan; 0 in a request is unlimited, so it takes the cap.
export const CAPPED = ["max-pages", "max-depth", "concurrency", "rate", "timeout", "max-body-size"] as const;

export interface Policy {
    name: string;
    // Punycode host suffixes, `*` for any host.
    hosts: string[];
    // A reason shown to the client; unset admits the host.
    ban?: string;
    rate?: { jobs: number; seconds: number };
    // Seconds a repeat of the same scan returns the job it repeats; unset queues every request.
    repeat?: number;
    caps: Partial<Record<(typeof CAPPED)[number], number>>;
    // Wall-clock seconds one scan may run before it is killed.
    scanTimeout: number;
    fetch: string[];
    rules: { allow?: string[]; deny: string[] };
}

export interface ServerSettings {
    redis: string;
    redisPasswordFile?: string;
    listen: { host: string; port: number };
    retention: number;
    workers: number;
    maxQueued: number;
    allowPrivate: boolean;
    // `org.spiderlint` keys every scan starts from, under the request’s.
    defaults: Record<string, unknown>;
    policies: Policy[];
    // One bucket per client address over job submissions, and the proxies whose X-Forwarded-For is believed.
    clients: { rate?: { jobs: number; seconds: number }; trusted: BlockList; providers: string[] };
}

const duration = { oneOf: [{ type: "string", pattern: String.raw`^\d+[smhd]?$` }, { type: "integer", minimum: 1 }] };
const positive = { type: "integer", minimum: 1 };
const rate = { type: "object", additionalProperties: false, required: ["jobs", "per"], properties: { jobs: positive, per: duration } };

const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
        redis: { type: "string", pattern: "^rediss?://" },
        "redis-password-file": { type: "string", minLength: 1 },
        listen: { type: "object", additionalProperties: false, properties: { host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65_535 } } },
        retention: duration,
        workers: positive,
        "max-queued": positive,
        "allow-private": { type: "boolean" },
        defaults: { type: "object" },
        clients: { type: "object", additionalProperties: false, properties: { rate: { oneOf: [rate, { const: false }] }, "trusted-proxies": { type: "array", items: { type: "string", minLength: 1 } }, "trust-providers": { type: "array", uniqueItems: true, items: { enum: Object.keys(PROVIDERS) } } } },
        policies: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "hosts"],
                properties: {
                    name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
                    hosts: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                    ban: { oneOf: [{ type: "boolean" }, { type: "string", minLength: 1 }] },
                    rate,
                    repeat: duration,
                    caps: { type: "object", additionalProperties: false, properties: { ...Object.fromEntries(CAPPED.map((key) => [key, { type: "integer", minimum: 1 }])), "scan-timeout": duration } },
                    fetch: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["auto", "http", "browser", "adaptive"] } },
                    rules: { type: "object", additionalProperties: false, properties: { allow: { type: "array", items: { type: "string" } }, deny: { type: "array", items: { type: "string" } } } },
                },
            },
        },
    },
};

const validate = new Ajv2020({ allErrors: true }).compile(schema);

interface RawPolicy {
    name: string;
    hosts: string[];
    ban?: boolean | string;
    rate?: { jobs: number; per: string | number };
    repeat?: string | number;
    caps?: Record<string, number | string>;
    fetch?: string[];
    rules?: { allow?: string[]; deny?: string[] };
}

// `ua`, `.ua`, `*.ua` and `україна` as the punycode suffix a hostname ends with; `*` stays.
export function hostSuffix(raw: string): string {
    const bare = raw.trim().toLowerCase().replace(/^\*?\./, "").replace(/\.$/, "");
    if (bare === "*") return bare;
    if (!URL.canParse(`http://${bare}/`)) throw new ConfigError(`policies: invalid host ${raw}`);
    return new URL(`http://${bare}/`).hostname;
}

function seconds(raw: string | number): number {
    return parseDuration(raw) ?? 0;
}

// One policy with durations in seconds, hosts in punycode and the secure defaults filled in.
function policyOf(raw: RawPolicy, isPrivateAllowed: boolean): Policy {
    const { "scan-timeout": scanTimeout = "10m", ...caps } = raw.caps ?? {};
    const fetch = raw.fetch ?? ["http"];
    if (!isPrivateAllowed && fetch.some((mode) => mode !== "http")) throw new ConfigError(`policies/${raw.name}/fetch: only http while allow-private is false, since the browser has no address guard`);
    return {
        name: raw.name,
        hosts: raw.hosts.map((host) => hostSuffix(host)),
        ...(raw.ban !== undefined && raw.ban !== false && { ban: raw.ban === true ? `scans of this host are disabled by policy ${raw.name}` : raw.ban }),
        ...(raw.rate && { rate: { jobs: raw.rate.jobs, seconds: seconds(raw.rate.per) } }),
        ...(raw.repeat !== undefined && { repeat: seconds(raw.repeat) }),
        caps: { "max-pages": 100, ...(caps as Policy["caps"]) },
        scanTimeout: seconds(scanTimeout),
        fetch,
        rules: { ...(raw.rules?.allow && { allow: raw.rules.allow }), deny: raw.rules?.deny ?? [] },
    };
}

// `10.0.0.0/8`, `fd00::/8` or one address as a block list entry; anything else throws ConfigError.
function trustedOf(entries: string[]): BlockList {
    const trusted = new BlockList();
    for (const entry of entries) {
        const [address = "", prefix] = entry.trim().split("/", 2);
        const family = isIP(address);
        if (family === 0 || (prefix !== undefined && !/^\d+$/.test(prefix))) throw new ConfigError(`server/clients/trusted-proxies: invalid address or network ${entry}`);
        const type = family === 6 ? "ipv6" : "ipv4";
        if (prefix === undefined) trusted.addAddress(address, type);
        else trusted.addSubnet(address, Number(prefix), type);
    }
    return trusted;
}

// A parsed document as settings; any violation throws ConfigError naming its path.
export function settingsOf(raw: unknown): ServerSettings {
    const document = raw ?? {};
    if (!validate(document)) throw new ConfigError((validate.errors ?? []).map((error) => describe(error, "server")).join("; "));
    const value = document as Record<string, unknown> & { listen?: { host?: string; port?: number }; policies?: RawPolicy[]; clients?: { rate?: RawPolicy["rate"] | false; "trusted-proxies"?: string[]; "trust-providers"?: string[] } };
    const allowPrivate = (value["allow-private"] as boolean | undefined) ?? false;
    const defaults = validateSubtree(value.defaults ?? {}, "server/defaults");
    const policies = (value.policies ?? [{ name: "default", hosts: ["*"] }]).map((policy) => policyOf(policy, allowPrivate));
    const names = policies.map((policy) => policy.name).filter((name, index, all) => all.indexOf(name) !== index);
    if (names.length > 0) throw new ConfigError(`server/policies: duplicate name ${names.join(", ")}`);
    return {
        redis: (value.redis as string | undefined) ?? "redis://127.0.0.1:6379",
        ...(value["redis-password-file"] !== undefined && { redisPasswordFile: value["redis-password-file"] as string }),
        listen: { host: value.listen?.host ?? "0.0.0.0", port: value.listen?.port ?? 8080 },
        retention: seconds((value.retention as string | number | undefined) ?? "7d"),
        workers: (value.workers as number | undefined) ?? 2,
        maxQueued: (value["max-queued"] as number | undefined) ?? 100,
        allowPrivate,
        defaults,
        policies,
        clients: { ...clientRate(value.clients?.rate), trusted: trustedOf(value.clients?.["trusted-proxies"] ?? []), providers: value.clients?.["trust-providers"] ?? [] },
    };
}

// The per-client bucket: 10 jobs an hour unless set, none when `false`.
function clientRate(raw: RawPolicy["rate"] | false | undefined): { rate?: { jobs: number; seconds: number } } {
    if (raw === false) return {};
    const { jobs, per } = raw ?? { jobs: 10, per: "1h" };
    return { rate: { jobs, seconds: seconds(per) } };
}

// The file’s settings; an absent file is the built-in defaults, one policy admitting every host.
export function readSettings(path: string): ServerSettings {
    const isPresent = existsSync(path);
    log.info({ path, isPresent }, "server settings read");
    return settingsOf(isPresent ? parseYaml(readFileSync(path, "utf8")) : {});
}

// Settings that follow the file: a valid edit replaces them, an invalid one is logged and ignored.
export function watchSettings(path: string): { current(): ServerSettings; close(): void } {
    let settings = readSettings(path);
    watchFile(path, { interval: WATCH_MS }, (now, before) => {
        log.debug({ path, modified: now.mtimeMs, previous: before.mtimeMs }, "server settings changed on disk");
        try {
            const next = readSettings(path);
            const restart = (["redis", "redisPasswordFile", "listen", "workers"] as const).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(settings[key]));
            if (restart.length > 0) log.warn({ keys: restart }, "server settings need a restart to take effect");
            settings = next;
            log.info({ path, policies: next.policies.map((policy) => policy.name) }, "server settings reloaded");
        } catch (error) {
            log.error({ path, error: error instanceof Error ? error.message : String(error) }, "server settings rejected; previous kept");
        }
    });
    return { current: () => settings, close: () => unwatchFile(path) };
}
