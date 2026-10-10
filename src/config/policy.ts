// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { normalizeVia } from "../agent.ts";
import { parseDuration, type BucketName } from "../cache/index.ts";
import { parseResolver } from "../crawl/dns.ts";
import { parsePin } from "../crawl/resolve.ts";
import { log } from "../logger.ts";
import { ConfigError, originOf, proxyOf, type Config } from "./index.ts";
import { CORE_KEYS, validateSubtree } from "./schema.ts";

const SUBTREE = "org.spiderlint";
const LEVELS = ["error", "warning", "info", "hint"] as const;
type Level = (typeof LEVELS)[number];
const DISCOVER_NAMES = ["projectfile.yaml", "projectfile.toml", "projectfile.json"];

export type Settings = Partial<
    Pick<
        Config,
        | "seeds"
        | "canonicalOrigin"
        | "role"
        | "fetch"
        | "browser"
        | "browserInstall"
        | "scope"
        | "concurrency"
        | "rate"
        | "timeout"
        | "profile"
        | "proxy"
        | "via"
        | "maxPages"
        | "maxDepth"
        | "maxBodySize"
        | "keepalive"
        | "fetchResources"
        | "maxResourcesPerPage"
        | "linkExclude"
        | "includeUrls"
        | "excludeUrls"
        | "vendorPaths"
        | "diversify"
        | "robots"
        | "sitemap"
        | "fold"
        | "failOn"
        | "format"
        | "excludeRules"
        | "documentTypes"
        | "overrides"
        | "rules"
        | "groups"
        | "rulesets"
        | "plugins"
        | "sources"
        | "cacheMode"
        | "cacheTtl"
        | "cacheFailureTtl"
        | "allowPrivate"
        | "resolver"
        | "resolve"
        | "pluginSettings"
    >
>;

// [subtree key, Settings field] — kebab-case document keys to the camelCase Config shape.
// `override` is excluded: its three severity buckets flatten into one field, below.
const KEYS: [string, keyof Settings][] = [
    ["targets", "seeds"],
    ["role", "role"],
    ["fetch", "fetch"],
    ["browser", "browser"],
    ["browser-install", "browserInstall"],
    ["scope", "scope"],
    ["concurrency", "concurrency"],
    ["rate", "rate"],
    ["timeout", "timeout"],
    ["profile", "profile"],
    ["max-pages", "maxPages"],
    ["max-depth", "maxDepth"],
    ["max-body-size", "maxBodySize"],
    ["keepalive", "keepalive"],
    ["include-urls", "includeUrls"],
    ["exclude-urls", "excludeUrls"],
    ["vendor-paths", "vendorPaths"],
    ["diversify", "diversify"],
    ["robots", "robots"],
    ["sitemap", "sitemap"],
    ["fold", "fold"],
    ["fail-on", "failOn"],
    ["format", "format"],
    ["exclude-rules", "excludeRules"],
    ["document-types", "documentTypes"],
    ["rules", "rules"],
    ["groups", "groups"],
    ["rulesets", "rulesets"],
    ["plugins", "plugins"],
    ["sources", "sources"],
    ["via", "via"],
    ["allow-private", "allowPrivate"],
];

// error, then warning, then info, then hint — a rule ID named in a later bucket wins (AGENTS.md ## Rules).
function flattenOverride(bucket: Partial<Record<Level, string[]>>): Settings["overrides"] {
    const overrides: Record<string, Level> = {};
    for (const level of LEVELS) {
        const ids = bucket[level] ?? [];
        for (const id of ids) overrides[id] = level;
    }
    return overrides;
}

// A duration to seconds; a malformed one names its path.
function seconds(field: string, raw: string | number): number {
    const parsed = parseDuration(raw);
    if (parsed === undefined) throw new ConfigError(`org.spiderlint/cache/${field}: invalid duration ${String(raw)} (expected seconds or 45s, 30m, 24h, 7d)`);
    return parsed;
}

// `cache.<bucket>.ttl` durations to seconds.
function cacheTtl(cache: Record<string, { ttl?: string | number }>): Settings["cacheTtl"] {
    const out: Partial<Record<BucketName, number>> = {};
    for (const [bucket, { ttl }] of Object.entries(cache)) {
        if (ttl !== undefined) out[bucket as BucketName] = seconds(`${bucket}/ttl`, ttl);
    }
    return out;
}

// One subtree’s keys as the camelCase Settings shape.
export function fromSubtree(subtree: Record<string, unknown>): Settings {
    const settings: Settings = {};
    for (const [key, field] of KEYS) {
        if (subtree[key] !== undefined) (settings as Record<string, unknown>)[field] = subtree[key];
    }
    const resources = subtree.resources as { fetch?: boolean; "max-per-page"?: number } | undefined;
    if (resources?.fetch !== undefined) settings.fetchResources = resources.fetch;
    if (resources?.["max-per-page"] !== undefined) settings.maxResourcesPerPage = resources["max-per-page"];
    const links = subtree.links as { exclude?: string[] } | undefined;
    if (links?.exclude !== undefined) settings.linkExclude = links.exclude.map((host) => host.toLowerCase());
    if (subtree["canonical-origin"] !== undefined) settings.canonicalOrigin = originOf("org.spiderlint/canonical-origin", subtree["canonical-origin"] as string);
    if (subtree.proxy !== undefined) settings.proxy = proxyOf("org.spiderlint/proxy", subtree.proxy as string);
    if (settings.via !== undefined) settings.via = normalizeVia(settings.via);
    if (subtree.resolver !== undefined) settings.resolver = parseResolver(subtree.resolver as string);
    if (subtree.resolve !== undefined) settings.resolve = (subtree.resolve as string[]).map((pin) => parsePin(pin));
    if (subtree.cache !== undefined) settings.cacheTtl = cacheTtl(subtree.cache as Record<string, { ttl?: string | number }>);
    const failureTtl = (subtree.cache as { resources?: { "failure-ttl"?: string | number } } | undefined)?.resources?.["failure-ttl"];
    if (failureTtl !== undefined) settings.cacheFailureTtl = seconds("resources/failure-ttl", failureTtl);
    if (subtree.override !== undefined) settings.overrides = flattenOverride(subtree.override as Partial<Record<Level, string[]>>);
    const plugins = Object.entries(subtree).filter(([key]) => !CORE_KEYS.has(key));
    if (plugins.length > 0) settings.pluginSettings = Object.fromEntries(plugins);
    return settings;
}

// Shared settings plus one patch per `sites.<name>`; a site key replaces the shared one whole.
function resolve(raw: unknown): { settings: Settings; sites: Record<string, Settings> } {
    const { sites = {}, ...shared } = validateSubtree(raw) as { sites?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    if (Object.keys(sites).length > 0 && shared.targets !== undefined) throw new ConfigError("org.spiderlint/targets: with sites, every target belongs to a sites.<name>.targets");
    log.debug({ sites: Object.keys(sites) }, "sites declared");
    const settings = fromSubtree(shared);
    // A site’s plugin key replaces the shared one of the same plugin, not every plugin’s.
    const patch = (site: Settings): Settings => (site.pluginSettings ? { ...site, pluginSettings: { ...settings.pluginSettings, ...site.pluginSettings } } : site);
    return { settings, sites: Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, patch(fromSubtree(site))])) };
}

// First recognised projectfile encoding present in the working directory.
function discover(): string | undefined {
    return DISCOVER_NAMES.find((name) => existsSync(name));
}

// null when pf-cli is not on PATH; otherwise the subtree (possibly an error).
function runPfCli(document: string): { raw?: unknown; error?: string } | undefined {
    const result = spawnSync("pf-cli", ["get", "-f", document, SUBTREE, "--format", "json", "--quiet"], { encoding: "utf8" });
    if (result.error) return undefined;
    // pf-cli answers a path the document lacks with `null` and exit 1.
    if (result.stdout.trim() === "null" && result.stderr.trim() === "") return { raw: {} };
    return result.status === 0 ? { raw: (JSON.parse(result.stdout || "null") ?? {}) as unknown } : { error: (result.stderr || result.stdout).trim() };
}

// No pf-cli: the file itself is parsed and its org.spiderlint key read directly.
function readPlainYaml(document: string): unknown {
    const parsed = parseYaml(readFileSync(document, "utf8")) as { org?: { spiderlint?: unknown } } | null;
    return parsed?.org?.spiderlint ?? {};
}

// Resolves the org.spiderlint subtree: explicit --config, else cwd discovery, else no file.
// pf-cli reads the document when it is on PATH; an explicit --config file falls back to a
// direct YAML parse otherwise, so outsiders need no pf-cli install (AGENTS.md ## Configuration).
export function loadSettings(explicit: string | undefined): { settings: Settings; sites: Record<string, Settings>; document: string | undefined } {
    if (explicit !== undefined && !existsSync(explicit)) throw new ConfigError(`config file not found: ${explicit}`);
    const document = explicit ?? discover();
    if (document === undefined) {
        log.debug({}, "no projectfile found, using defaults");
        return { settings: {}, sites: {}, document: undefined };
    }
    const pfResult = runPfCli(document);
    if (pfResult === undefined) {
        if (explicit === undefined) {
            log.info({ document }, "pf-cli not found, skipping projectfile config");
            return { settings: {}, sites: {}, document };
        }
        log.debug({ document }, "pf-cli not found, parsing config file directly");
        return { ...resolve(readPlainYaml(document)), document };
    }
    if (pfResult.error !== undefined) throw new ConfigError(`pf-cli: cannot read ${SUBTREE} from ${document}: ${pfResult.error}`);
    log.debug({ document }, "config subtree loaded via pf-cli");
    return { ...resolve(pfResult.raw), document };
}
