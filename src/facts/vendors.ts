// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import picomatch from "picomatch";
import { parse } from "yaml";
import { log } from "../logger.ts";
import type { Finding } from "../rules/types.ts";
import type { Facts, SiteFacts } from "./types.ts";

export type VendorKind = "page" | "resource";

// One path an edge or host serves on the site, as `vendors/paths.yaml` lists it.
export interface VendorPath {
    vendor: string;
    match: string;
    kind: VendorKind[];
    docs: string;
    feature?: string;
}

const FILE = new URL("../../vendors/paths.yaml", import.meta.url);

type Compiled = VendorPath & { isMatch: picomatch.Matcher };

const cache: { paths?: Compiled[] } = {};

// The shipped list, read and compiled once.
export function vendorPaths(): Compiled[] {
    if (cache.paths) return cache.paths;
    cache.paths = (parse(readFileSync(FILE, "utf8")) as VendorPath[]).map((entry) => ({ ...entry, isMatch: picomatch(entry.match, { dot: true }) }));
    log.debug({ entries: cache.paths.length }, "vendor paths loaded");
    return cache.paths;
}

// The first entry whose glob matches the URL’s path, when it is of `kind`.
export function vendorPath(href: string, kind: VendorKind): VendorPath | undefined {
    if (!URL.canParse(href)) return undefined;
    const entry = vendorPaths().find((candidate) => candidate.isMatch(new URL(href).pathname));
    return entry?.kind.includes(kind) ? entry : undefined;
}

// Each page’s anchors into a vendor path as `html.links.vendor`, and each origin’s detected vendor features as `site.origins.*.vendor`; `isOn` false clears both.
export function vendorFacts(pages: Facts[], site: SiteFacts, isOn: boolean): void {
    const byOrigin = new Map<string, Set<string>>();
    for (const page of pages) {
        if (page.html) delete page.html.links.vendor;
        if (!isOn) continue;
        const anchors = page.html ? [...page.html.links.internal, ...page.html.links.external] : [];
        const linked = anchors.flatMap((href) => {
            const entry = vendorPath(href, "page");
            return entry ? [{ href, entry }] : [];
        });
        const loads = [...(page.resources ?? []).map((resource) => resource.url), ...(page.html?.scripts ?? []).flatMap((script) => script.src ?? [])];
        const loaded = loads.flatMap((href) => vendorPath(href, "resource") ?? []);
        if (page.html && linked.length > 0) page.html.links.vendor = Object.fromEntries(linked.map(({ entry, href }) => [href, entry.vendor]));
        const features = [...linked.map(({ entry }) => entry), ...loaded].flatMap((entry) => entry.feature ?? []);
        if (features.length > 0) byOrigin.set(page.url.origin, new Set([...(byOrigin.get(page.url.origin) ?? []), ...features]));
        log.debug({ url: page.url.href, links: linked.length, resources: loaded.length, features }, "vendor paths found");
    }
    const origins = Object.values(site.origins ?? {});
    for (const facts of origins) delete facts.vendor;
    for (const [origin, features] of byOrigin) site.origins = { ...site.origins, [origin]: { ...site.origins?.[origin], vendor: { features: [...features].toSorted((a, b) => a.localeCompare(b)) } } };
    log.debug({ isOn, origins: Object.fromEntries([...byOrigin].map(([origin, features]) => [origin, [...features]])) }, "vendor features detected");
}

// Site findings about a vendor’s resource carry the vendor, so formatters list them apart from the site’s own.
export function attributeVendors(findings: Finding[], isOn: boolean): void {
    if (!isOn) return;
    const attributed = findings.filter((finding) => finding.scope === "site").flatMap((finding) => {
        const entry = vendorPath(finding.url, "resource");
        if (entry) finding.vendor = entry.vendor;
        return entry ? [finding.rule] : [];
    });
    log.debug({ findings: attributed.length, rules: [...new Set(attributed)] }, "vendor findings attributed");
}
