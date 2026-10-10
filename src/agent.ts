// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createRequire } from "node:module";

export const { version: VERSION, description: DESCRIPTION, homepage: HOMEPAGE, license: LICENSE } = createRequire(import.meta.url)("../package.json") as { version: string; description: string; homepage: string; license: string };

// How every request names the tool (AGENTS.md ## Security).
export const USER_AGENT = `spiderlint/${VERSION} (+https://kiota.ch/damian-buho/spiderlint)`;

// Chromium major got-scraping currently impersonates; bump together with it.
const CHROME_MAJOR = "147";

// The instance a web scan runs on, from its request Host header; empty on the CLI.
const SCAN = { via: "" };

// The instance `setVia` keeps, without port, path, casing or brackets; garbage becomes empty.
export function normalizeVia(raw: string | undefined): string {
    const host = (raw ?? "").trim().toLowerCase().split("/", 1)[0] ?? "";
    const bare = host.startsWith("[") ? (host.slice(1).split("]", 1)[0] ?? "") : (host.split(":", 1)[0] ?? "");
    return /^[a-z0-9:]([a-z0-9.:-]*[a-z0-9])?\.?$/.test(bare) ? bare.replace(/\.$/, "") : "";
}

// Remembers the instance web scans advertise; the CLI leaves it empty.
export function setVia(raw?: string): void {
    SCAN.via = normalizeVia(raw);
}

// The tool token, with `; via <host>` on a web scan so the owner knows which instance knocked.
export function userAgent(via: string = SCAN.via): string {
    return via ? `${USER_AGENT.slice(0, -1)}; via ${via})` : USER_AGENT;
}

// The Chromium major a `Chrome/<major>` UA carries; undefined on Firefox or WebKit.
export function chromeMajorOf(ua: string): string | undefined {
    return /Chrome\/(\d+)/.exec(ua)?.[1];
}

// Low-entropy Client Hints matching the Chromium major behind `ua`, else the impersonated one.
export function clientHints(ua?: string): Record<string, string> {
    const major = (ua && chromeMajorOf(ua)) || CHROME_MAJOR;
    return { "sec-ch-ua": `"Chromium";v="${major}", "Not-A.Brand";v="8", "spiderlint";v="${VERSION}"`, "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": `"Linux"` };
}

// A browser’s own UA with the tool token appended, so the owner knows it is no real Chrome.
export function browserAgent(real: string, via: string = SCAN.via): string {
    return `${real} ${userAgent(via)}`;
}

// What a browser context sends: the real UA with the token appended, and matching Client Hints on Chromium.
export function browserContext(real: string, via: string = SCAN.via): { userAgent: string; extraHTTPHeaders?: Record<string, string> } {
    return { userAgent: browserAgent(real, via), ...(chromeMajorOf(real) && { extraHTTPHeaders: clientHints(real) }) };
}

// The headers every own-client request sends: the token with `via`, and the Client Hints.
export function agentHeaders(via: string = SCAN.via): Record<string, string> {
    return { "user-agent": userAgent(via), ...clientHints() };
}
