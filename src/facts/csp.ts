// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { CspFacts, Facts } from "./types.ts";

type Directives = Record<string, string[]>;

// Directives a `<meta>` policy cannot carry (CSP 3 §3.3).
const HEADER_ONLY = new Set(["frame-ancestors", "report-uri", "sandbox"]);

// Each fetch directive’s fallback chain, ending at `default-src` (CSP 3 §6.8.3).
const FALLBACK: Record<string, string[]> = {
    "script-src-elem": ["script-src", "default-src"],
    "script-src-attr": ["script-src", "default-src"],
    "style-src-elem": ["style-src", "default-src"],
    "style-src-attr": ["style-src", "default-src"],
    "worker-src": ["child-src", "script-src", "default-src"],
    "frame-src": ["child-src", "default-src"],
    ...Object.fromEntries(["script-src", "style-src", "img-src", "font-src", "connect-src", "media-src", "object-src", "manifest-src", "child-src"].map((name) => [name, ["default-src"]])),
};

const isNonceOrHash = (source: string): boolean => /^'(nonce|sha256|sha384|sha512)-/i.test(source);
const isKeyword = (source: string): boolean => source.startsWith("'");

// A policy as the browser reads it: a later duplicate directive ignored, `'unsafe-inline'` dropped beside a nonce or hash, host sources beside `'strict-dynamic'`.
export function parsePolicy(text: string, isMeta = false): Directives {
    const directives: Directives = {};
    for (const part of text.split(";")) {
        const [name = "", ...sources] = part.trim().split(/\s+/);
        const key = name.toLowerCase();
        if (!key || Object.hasOwn(directives, key) || (isMeta && HEADER_ONLY.has(key))) continue;
        const hasNonce = sources.some((source) => isNonceOrHash(source));
        const isDynamic = hasNonce && sources.some((source) => source.toLowerCase() === "'strict-dynamic'");
        directives[key] = sources.filter((source) => !(hasNonce && source.toLowerCase() === "'unsafe-inline'") && !(isDynamic && (!isKeyword(source) || source.toLowerCase() === "'self'")));
    }
    return directives;
}

// The directive that governs `name` in one policy, through its fallback chain.
function governing(policy: Directives, name: string): string[] | undefined {
    for (const candidate of [name, ...(FALLBACK[name] ?? [])]) if (Object.hasOwn(policy, candidate)) return policy[candidate];
    return undefined;
}

// Several policies are all enforced, so a source survives only where every policy governing its directive allows it.
export function combine(policies: Directives[]): Directives | undefined {
    if (policies.length === 0) return undefined;
    const names = new Set(policies.flatMap((policy) => Object.keys(policy)));
    const combined: Directives = {};
    for (const name of names) {
        const lists = policies.map((policy) => governing(policy, name)).filter((list) => list !== undefined);
        const [first = [], ...rest] = lists;
        combined[name] = first.filter((source) => rest.every((list) => list.some((other) => other.toLowerCase() === source.toLowerCase())));
    }
    return combined;
}

// Policy texts of one header, which may repeat or join several with a comma.
function texts(value: string | string[] | undefined): string[] {
    return [value ?? []]
        .flat()
        .flatMap((line) => line.split(","))
        .filter((text) => text.trim());
}

// The enforced and the report-only policies of a page, from its headers and `<meta http-equiv>` elements, each set combined as the browser enforces it.
export function cspFacts(page: Facts): CspFacts | undefined {
    const metas = (page.html?.["http-equiv"] ?? []).filter((meta) => meta.name === "content-security-policy").map((meta) => parsePolicy(meta.content, true));
    const enforced = [...texts(page.http.headers["content-security-policy"]).map((text) => parsePolicy(text)), ...metas];
    const reportOnly = texts(page.http.headers["content-security-policy-report-only"]).map((text) => parsePolicy(text));
    if (enforced.length === 0 && reportOnly.length === 0) return undefined;
    const directives = combine(enforced);
    const report = combine(reportOnly);
    log.debug({ url: page.url.href, policies: enforced.length, meta: metas.length, reportOnly: reportOnly.length }, "content security policy read");
    return { policies: enforced.length, ...(directives && { directives }), ...(report && { "report-only": { policies: reportOnly.length, directives: report } }) };
}
