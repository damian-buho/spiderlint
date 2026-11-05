// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";

export type Darknet = "tor" | "i2p";

// Failures of the connection to the proxy itself, which say nothing about the link behind it.
const PROXY_DOWN = /\b(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)\b|Socket closed/;

// The overlay network `host` lives on, undefined for the public internet.
export function darknetOf(host: string): Darknet | undefined {
    const name = host.toLowerCase().replace(/\.$/, "");
    return name.endsWith(".onion") ? "tor" : name.endsWith(".i2p") ? "i2p" : undefined;
}

// Whether `error` says the proxy, not the link behind it, did not answer.
export function isProxyDown(error: string): boolean {
    return PROXY_DOWN.test(error);
}

// Whether a 5xx is the I2P proxy’s own error page, which names `proxy.i2p` in its CSP, standing in for a service it could not reach.
export function isProxyPage(status: number, headers: Record<string, string | string[]>): boolean {
    return status >= 500 && [headers["content-security-policy"] ?? []].flat().join(",").includes("proxy.i2p");
}

// An agent reaching `url` through `proxy`, which resolves the name, so no DNS query leaves this process.
export function agentThrough(proxy: string, url: URL, timeout: number): HttpAgent {
    if (proxy.startsWith("socks")) return new SocksProxyAgent(proxy, { timeout });
    const environment = { HTTP_PROXY: proxy, HTTPS_PROXY: proxy };
    return url.protocol === "https:" ? new HttpsAgent({ proxyEnv: environment }) : new HttpAgent({ proxyEnv: environment });
}
