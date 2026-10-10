// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { BlockList, isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { agentHeaders } from "../agent.ts";
import { log } from "../logger.ts";

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const CIDR = /[\d.:a-f]+\/\d{1,3}/gi;

// Documents naming each CDN's own edge space, as o9s/traefik reads them.
export const PROVIDERS: Record<string, string[]> = {
    cloudflare: ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"],
    akamai: ["https://techdocs.akamai.com/property-manager/pdfs/akamai_ipv4_CIDRs.txt", "https://techdocs.akamai.com/property-manager/pdfs/akamai_ipv6_CIDRs.txt"],
    fastly: ["https://api.fastly.com/public-ip-list"],
};

// One document's text, retried with backoff and jitter; the last failure throws.
async function fetchText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { ...agentHeaders() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) throw new Error(`${url} answers ${response.status}`);
            return await response.text();
        } catch (error) {
            log.debug({ url, attempt, error: String(error) }, "edge range fetch failed");
            if (attempt === ATTEMPTS - 1) throw error;
            await sleep(500 * 2 ** attempt + Math.random() * 250);
        }
    }
}

// The CIDR-shaped entries of `text` added to `list`; how many were valid.
export function addRanges(list: BlockList, text: string): number {
    let added = 0;
    for (const [range] of text.matchAll(CIDR)) {
        const [address = "", prefix = ""] = range.split("/", 2);
        const family = isIP(address);
        if (family === 0 || Number(prefix) > (family === 6 ? 128 : 32)) continue;
        list.addSubnet(address, Number(prefix), family === 6 ? "ipv6" : "ipv4");
        added += 1;
    }
    return added;
}

// The live edge ranges of `providers`; a provider whose documents fail is skipped with a warning.
export async function edgeRanges(providers: string[]): Promise<BlockList> {
    const list = new BlockList();
    for (const provider of providers) {
        try {
            const texts = await Promise.all((PROVIDERS[provider] ?? []).map(async (url) => fetchText(url)));
            log.info({ provider, ranges: addRanges(list, texts.join("\n")) }, "edge ranges trusted");
        } catch (error) {
            log.warn({ provider, error: String(error) }, "edge ranges not fetched; keeping the other sources");
        }
    }
    return list;
}
