// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import picomatch from "picomatch";
import { getDomain } from "tldts";
import { parse } from "yaml";
import { reason } from "../crawl/fetch.ts";
import { vendorPath } from "../facts/vendors.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { records } from "./dns.ts";
import { definePlugin, type SiteContext, type SiteExtractor } from "./types.ts";

// One service as `vendors/stack.yaml` lists it; every signal is optional.
interface Service {
    name: string;
    kind: string;
    ranges?: { lists: string[]; bundled: string[] };
    headers?: Record<string, string>;
    cookies?: string[];
    generator?: string[];
    paths?: string[];
    nameservers?: string[];
    docs: string;
}

// What an origin runs on for one kind: the service, the signals that matched, and how sure that is.
export interface StackEntry {
    name: string;
    kind: string;
    evidence: string[];
    confidence: "high" | "medium";
}

const FILE = new URL("../../vendors/stack.yaml", import.meta.url);

const cache: { services?: Service[] } = {};

// The shipped list, read once.
function services(): Service[] {
    if (!cache.services) {
        cache.services = parse(readFileSync(FILE, "utf8")) as Service[];
        log.debug({ services: cache.services.length }, "stack services loaded");
    }
    return cache.services;
}

// Whether `value` matches any of `globs`, ignoring case.
const isAny = (globs: string[], value: string): boolean => picomatch(globs, { nocase: true, dot: true })(value);

// Whether `value` matches the glob, where `*` also crosses `/` as a header value needs.
const isLike = (glob: string, value: string): boolean =>
    new RegExp(
        `^${glob
            .split("*")
            .map((part) => part.replaceAll(/[$()+.?[\\\]^{|}]/g, String.raw`\$&`))
            .join(".*")}$`,
        "i",
    ).test(value);

// The CIDR blocks among `subnets` as a lookup; a line that is not one is dropped.
function blocksOf(subnets: string[]): BlockList {
    const blocks = new BlockList();
    for (const subnet of subnets) {
        const [network = "", prefix = ""] = subnet.split("/", 2);
        const family = isIP(network);
        if (family > 0 && /^\d{1,3}$/.test(prefix)) blocks.addSubnet(network, Number(prefix), family === 6 ? "ipv6" : "ipv4");
    }
    return blocks;
}

// A service’s published ranges from the `lists` bucket, the bundled ones when the download fails or names none.
async function rangesOf(service: Service, context: SiteContext): Promise<BlockList> {
    const { lists, bundled } = service.ranges as NonNullable<Service["ranges"]>;
    try {
        const bodies = await Promise.all(lists.map((url) => context.list(url)));
        const subnets = bodies.flatMap((body) => body.split(/\s+/).filter(Boolean));
        log.debug({ service: service.name, lists, subnets: subnets.length }, "service ranges downloaded");
        if (subnets.length > 0) return blocksOf(subnets);
    } catch (error) {
        if (context.signal.aborted) throw error;
        log.debug({ service: service.name, lists, error: reason(error), bundled: bundled.length }, "service ranges not downloaded; bundled list used");
    }
    return blocksOf(bundled);
}

// The address `host` resolves to, none when it is private or unresolved.
async function addressOf(host: string, context: SiteContext): Promise<string | undefined> {
    try {
        return await context.address(host);
    } catch (error) {
        if (context.signal.aborted) throw error;
        log.debug({ host, error: reason(error) }, "stack address unknown");
    }
}

// The name servers of the host’s registrable domain, lower case and without the root dot; none when the query fails.
async function nameserversOf(host: string, context: SiteContext): Promise<string[]> {
    const domain = getDomain(host, { allowPrivateDomains: true }) ?? host;
    try {
        return records<string>(await context.dns.query(domain, "NS"), "NS").map(({ data }) => String(data).toLowerCase().replace(/\.$/, ""));
    } catch (error) {
        if (context.signal.aborted) throw error;
        log.debug({ domain, error: reason(error) }, "stack name servers unknown");
        return [];
    }
}

// Every header, cookie name, generator, same-origin path and URL the origin’s pages show.
function observed(pages: readonly Facts[], origin: string) {
    const headers = pages.flatMap((page) => Object.entries(page.http?.headers ?? {}).map(([name, value]): [string, string] => [name.toLowerCase(), [value].flat().join(", ")]));
    const cookies = new Set(pages.flatMap((page) => (page.http?.cookies ?? []).map((cookie) => cookie.name)));
    const generators = new Set(pages.flatMap((page) => page.html?.meta.generator ?? []));
    const urls = new Set(pages.flatMap((page) => [page.url.href, ...(page.resources ?? []).map((resource) => resource.url), ...(page.html?.scripts ?? []).flatMap((script) => script.src ?? [])]));
    const paths = new Set([...urls].filter((href) => URL.canParse(href) && new URL(href).origin === origin).map((href) => new URL(href).pathname));
    return { headers, cookies, generators, paths, urls };
}

// Whether the address lies in the service’s published ranges.
async function isInRanges(service: Service, address: string | undefined, context: SiteContext): Promise<boolean> {
    const family = address ? isIP(address) : 0;
    if (family === 0 || !address || !service.ranges) return false;
    const ranges = await rangesOf(service, context);
    return ranges.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Whether one of the service’s name server globs matches a name server of the origin’s domain.
async function nameserverOf(service: Service, nameservers: () => Promise<string[]>): Promise<string | undefined> {
    if (!service.nameservers) return;
    const names = await nameservers();
    return names.find((candidate) => isAny(service.nameservers as string[], candidate));
}

// The signals of one service that the origin shows, as the evidence lines they leave.
async function evidenceOf(service: Service, seen: ReturnType<typeof observed>, host: string, address: string | undefined, nameservers: () => Promise<string[]>, context: SiteContext): Promise<string[]> {
    const found: string[] = [];
    if (await isInRanges(service, address, context)) found.push(`address ${address}`);
    const wanted = Object.entries(service.headers ?? {});
    for (const [name, glob] of wanted) {
        const header = seen.headers.find(([key, value]) => key === name && isLike(glob, value));
        if (header) found.push(`header ${name}: ${header[1]}`);
    }
    const cookies = [...seen.cookies].filter((name) => service.cookies?.some((glob) => isLike(glob, name))).map((name) => `cookie ${name}`);
    const generators = [...seen.generators].filter((generator) => service.generator?.some((glob) => isLike(glob, generator))).map((generator) => `generator ${generator}`);
    found.push(...cookies, ...generators);
    const path = [...seen.paths].find((candidate) => service.paths && isAny(service.paths, candidate));
    const vendored = [...seen.urls].map((href) => vendorPath(href, "page") ?? vendorPath(href, "resource")).find((entry) => entry?.vendor.toLowerCase() === service.name);
    if (path ?? vendored) found.push(`path ${path ?? vendored?.match}`);
    const server = await nameserverOf(service, nameservers);
    if (server) found.push(`nameserver ${server}`);
    log.debug({ host, service: service.name, signals: found.length }, "service signals read");
    return found;
}

// What each kind of service the origin runs on is, from its address, headers, cookies, generator, paths and name servers; nothing when no signal matches.
const stack: SiteExtractor = {
    id: "stack",
    per: "origin",
    resolves: true,
    cached: false,
    async extract(origin, context) {
        const host = new URL(origin).hostname.replaceAll(/^\[|\]$/g, "");
        const address = await addressOf(host, context);
        const seen = observed(context.pages, origin);
        let asked: Promise<string[]> | undefined;
        const nameservers = () => (asked ??= nameserversOf(host, context));
        const best = new Map<string, StackEntry>();
        for (const service of services()) {
            const evidence = await evidenceOf(service, seen, host, address, nameservers, context);
            if (evidence.length === 0 || evidence.length <= (best.get(service.kind)?.evidence.length ?? 0)) continue;
            best.set(service.kind, { name: service.name, kind: service.kind, evidence, confidence: evidence.length > 1 ? "high" : "medium" });
        }
        log.debug(
            {
                origin,
                stack: best
                    .values()
                    .map((entry) => `${entry.kind}:${entry.name}`)
                    .toArray(),
            },
            "stack detected",
        );
        return best.size > 0 ? Object.fromEntries(best) : undefined;
    },
};

// The services an origin runs on, as `site.origins.*.stack`.
export default definePlugin({ name: "stack", sites: [stack] });
