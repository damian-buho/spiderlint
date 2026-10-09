// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import picomatch from "picomatch";
import { ConfigError } from "../config/index.ts";
import { fromSubtree } from "../config/policy.ts";
import { validateSubtree } from "../config/schema.ts";
import { validateRules } from "../index.ts";
import { log } from "../logger.ts";
import { CAPPED, type Policy, type ServerSettings } from "./settings.ts";

// `org.spiderlint` keys a request may set; the rest read files, load code, leave the address guard or skip robots.txt.
const REQUEST_KEYS = new Set(["canonical-origin", "rules", "exclude-rules", "override", "groups", "fetch", "browser", "scope", "concurrency", "rate", "timeout", "max-pages", "max-depth", "max-body-size", "keepalive", "include-urls", "exclude-urls", "resources", "links", "sitemap", "fold"]);

// Rules whose extractors connect to ports a stranger’s URL must never aim the server at.
export const NEVER_SERVED = ["sshfp", "sshfp/*"];

// What the form lets a visitor pick, default first, and the settings each lowers beside its rules; the policy still clamps after, so none raises a cap.
export const WEB_PRESETS: Record<string, Record<string, unknown>> = {
    recommended: {},
    "web-quick": { "max-pages": 25, resources: { fetch: false } },
    "web-comprehensive": {},
};

// A request the server turns down, with a stable code a client can translate.
export class Refusal extends Error {
    readonly status: 400 | 403 | 404 | 409 | 429 | 503;
    readonly code: string;
    readonly retryAfter?: number;

    constructor(status: Refusal["status"], code: string, message: string, retryAfter?: number) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

export interface Admitted {
    url: string;
    host: string;
    policy: Policy;
    // The `org.spiderlint` subtree the scan runs with.
    settings: Record<string, unknown>;
}

// The http or https seed, without credentials, and its lowercase host without a trailing dot.
export function seedOf(raw: unknown): { url: string; host: string } {
    const url = typeof raw === "string" && URL.canParse(raw) ? new URL(raw) : undefined;
    if (!url || !["http:", "https:"].includes(url.protocol)) throw new Refusal(400, "invalid-url", "url: expected an absolute http or https URL");
    if (url.username || url.password) throw new Refusal(400, "invalid-url", "url: credentials are not accepted");
    return { url: url.href, host: url.hostname.replace(/\.$/, "") };
}

// The first policy with a suffix `host` equals or ends in.
export function policyFor(host: string, policies: Policy[]): Policy | undefined {
    const bare = host.replaceAll(/^\[|\]$/g, "");
    return policies.find((policy) => policy.hosts.some((suffix) => suffix === "*" || bare === suffix || bare.endsWith(`.${suffix}`)));
}

// `raw` under the cap, where 0 or unset is unlimited and so takes the cap.
function capped(raw: unknown, cap: number | undefined): unknown {
    if (cap === undefined) return raw;
    return raw === undefined || raw === 0 || (raw as number) > cap ? cap : raw;
}

// Every ruleset or rule ID the scan names, `recommended` when none is named.
function namedRules(settings: Record<string, unknown>): string[] {
    // The implicit `default` group is always there, as `groupsOf` adds it.
    const groups: { rules?: string[] }[] = Object.values({ default: {}, ...(settings.groups as Record<string, { rules?: string[] }> | undefined) });
    const named = [...((settings.rules as string[] | undefined) ?? []), ...groups.flatMap((group) => group.rules ?? [])];
    const isImplicit = settings.rules === undefined && groups.some((group) => group.rules === undefined);
    return [...new Set([...named, ...(isImplicit ? ["recommended"] : [])])];
}

// Each named rule must match an `allow` entry and no `deny` entry.
function checkRules(settings: Record<string, unknown>, policy: Policy): void {
    const isDenied = picomatch([...policy.rules.deny, ...NEVER_SERVED]);
    const isAllowed = policy.rules.allow ? picomatch(policy.rules.allow) : () => true;
    for (const id of namedRules(settings)) {
        log.debug({ id, policy: policy.name }, "requested rule checked");
        if (isDenied(id) || !isAllowed(id)) throw new Refusal(403, "forbidden-rule", `rules: ${id} is not allowed by policy ${policy.name}`);
    }
}

// The request settings of the web preset `name`, or a refusal when the form never offered it.
export function presetSettings(name: string): Record<string, unknown> {
    if (!Object.hasOwn(WEB_PRESETS, name)) throw new Refusal(400, "unknown-rule", `preset: ${name} is not a web preset`);
    log.debug({ preset: name }, "web preset chosen");
    return { rules: [name], ...WEB_PRESETS[name] };
}

// The web presets some admitting policy lets a request name, in the form’s order; the host typed picks the policy, so each stays checked on submit.
export function presetsOffered(server: ServerSettings): string[] {
    const policies = server.policies.filter((policy) => policy.ban === undefined);
    const offered = Object.keys(WEB_PRESETS).filter((name) =>
        policies.some((policy) => {
            try {
                checkRules({ rules: [name] }, policy);
                return true;
            } catch (error) {
                if (error instanceof Refusal) return false;
                throw error;
            }
        }),
    );
    log.debug({ offered, policies: policies.length }, "web presets offered");
    return offered;
}

// Each fetch mode the scan names must be allowed; unnamed, it takes the policy’s first.
function checkFetch(settings: Record<string, unknown>, policy: Policy): Record<string, unknown> {
    const groups = Object.values((settings.groups ?? {}) as Record<string, { fetch?: string }>);
    const named = [settings.fetch, ...groups.map((group) => group.fetch)].filter((mode): mode is string => mode !== undefined);
    const refused = named.find((mode) => !policy.fetch.includes(mode));
    if (refused) throw new Refusal(403, "forbidden-fetch", `fetch: ${refused} is not allowed by policy ${policy.name} (allowed: ${policy.fetch.join(", ")})`);
    return settings.fetch === undefined ? { ...settings, fetch: policy.fetch.includes("auto") ? "auto" : policy.fetch[0] } : settings;
}

// The request as the scan will run it, or the Refusal naming why it may not run.
export function admit(body: unknown, server: ServerSettings): Admitted {
    const { url: rawUrl, settings: requested = {} } = (body ?? {}) as { url?: unknown; settings?: unknown };
    const { url, host } = seedOf(rawUrl);
    const policy = policyFor(host, server.policies);
    log.info({ host, policy: policy?.name, isBanned: policy?.ban !== undefined }, "policy matched");
    if (!policy) throw new Refusal(403, "no-policy", `${host}: no policy admits this host`);
    if (policy.ban) throw new Refusal(403, "banned", policy.ban);
    if (typeof requested !== "object" || requested === null || Array.isArray(requested)) throw new Refusal(400, "invalid-settings", "settings: expected an object");
    const forbidden = Object.keys(requested).filter((key) => !REQUEST_KEYS.has(key));
    if (forbidden.length > 0) throw new Refusal(400, "forbidden-setting", `settings: ${forbidden.join(", ")} cannot be set through the server`);
    let settings: Record<string, unknown>;
    try {
        settings = validateSubtree({ ...server.defaults, ...requested }, "settings");
    } catch (error) {
        if (error instanceof ConfigError) throw new Refusal(400, "invalid-settings", error.message);
        throw error;
    }
    checkRules(settings, policy);
    settings = checkFetch(settings, policy);
    const caps = Object.fromEntries(CAPPED.map((key) => [key, capped(settings[key], policy.caps[key])]).filter(([, value]) => value !== undefined));
    log.debug({ host, policy: policy.name, caps, denied: policy.rules.deny.length }, "request clamped");
    return { url, host, policy, settings: { ...settings, ...caps, robots: true, "allow-private": server.allowPrivate, "browser-install": false } };
}

// Refuses a scan naming a ruleset or rule no configured plugin defines, before any window is charged.
export async function resolveRules(admitted: Admitted): Promise<void> {
    try {
        await validateRules({ ...fromSubtree(admitted.settings), seeds: [admitted.url] });
    } catch (error) {
        if (error instanceof ConfigError) throw new Refusal(400, "unknown-rule", error.message);
        throw error;
    }
    log.debug({ host: admitted.host }, "requested rules resolved");
}
