// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "../rules/types.ts";
import { TRACKERS } from "./trackers-registry.ts";
import { definePlugin } from "./types.ts";

const HOSTS = Object.entries(TRACKERS).flatMap(([vendor, hosts]) => hosts.map((host) => [host, vendor] as const));

// The vendor whose tracker host is `host` or a parent of it.
function vendorOf(host: string): string | undefined {
    return HOSTS.find(([tracker]) => host === tracker || host.endsWith(`.${tracker}`))?.[1];
}

// One finding per tracker vendor a page loads from, with its hosts and the pages loading it.
const inventory: Make = (severity) => ({
    meta: { id: "trackers/inventory", severity, scope: "site", facts: ["resources"], docs: "https://specification.website/spec/privacy/analytics-privacy/", fix: "Drop the vendor, or name it in the privacy policy and load it only after consent." },
    check(pages: Facts[]) {
        const found = new Map<string, { hosts: Set<string>; urls: Set<string> }>();
        for (const page of pages) {
            const resources = page.resources ?? [];
            for (const resource of resources) {
                const host = URL.canParse(resource.url) ? new URL(resource.url).hostname : "";
                const vendor = vendorOf(host);
                if (!vendor) continue;
                const entry = found.get(vendor) ?? { hosts: new Set(), urls: new Set() };
                found.set(vendor, entry);
                entry.hosts.add(host);
                entry.urls.add(page.url.href);
            }
        }
        log.debug({ rule: "trackers/inventory", pages: pages.length, vendors: found.keys().toArray() }, "trackers inventoried");
        return found.entries().map(([vendor, { hosts, urls }]): Finding => ({ rule: "trackers/inventory", severity, scope: "site", url: `https://${hosts.values().next().value}/`, message: `${vendor} loads from ${hosts.values().toArray().join(", ")} on ${urls.size} page${urls.size === 1 ? "" : "s"}`, value: hosts.values().toArray(), urls: urls.values().toArray() })).toArray();
    },
});

export default definePlugin({
    name: "trackers",
    rules: { "trackers/inventory": inventory },
    presets: {
        trackers: {
            description: "Inventory of the analytics and ad-tech vendors the site loads, from a hand-kept host list",
            rules: { "trackers/inventory": "info" },
        },
    },
});
