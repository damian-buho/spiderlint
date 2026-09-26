// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { parseDuration, type BucketName } from "../cache/index.ts";
import { parseResolver } from "../crawl/dns.ts";
import { log } from "../logger.ts";
import { ConfigError, originOf, proxyOf, type Config } from "./index.ts";
import { validateSubtree } from "./schema.ts";

const SUBTREE = "org.spiderlint";
const DISCOVER_NAMES = ["projectfile.yaml", "projectfile.toml", "projectfile.json"];

export type Settings = Partial<Pick<Config, "seeds" | "canonicalOrigin" | "fetch" | "browser" | "scope" | "concurrency" | "rate" | "proxy" | "maxPages" | "maxDepth" | "maxBodySize" | "keepalive" | "fetchResources" | "maxResourcesPerPage" | "linkExclude" | "include" | "exclude" | "robots" | "sitemap" | "fold" | "failOn" | "format" | "disabledRules" | "overrides" | "rules" | "groups" | "rulesets" | "plugins" | "sources" | "cacheMode" | "cacheTtl" | "resolver">>;

// [subtree key, Settings field] — kebab-case document keys to the camelCase Config shape.
// `override` is excluded: its three severity buckets flatten into one field, below.
const KEYS: [string, keyof Settings][] = [
    ["targets", "seeds"],
    ["fetch", "fetch"],
    ["browser", "browser"],
    ["scope", "scope"],
    ["concurrency", "concurrency"],
    ["rate", "rate"],
    ["max-pages", "maxPages"],
    ["max-depth", "maxDepth"],
    ["max-body-size", "maxBodySize"],
    ["keepalive", "keepalive"],
    ["include", "include"],
    ["exclude", "exclude"],
    ["robots", "robots"],
    ["sitemap", "sitemap"],
    ["fold", "fold"],
    ["fail-on", "failOn"],
    ["format", "format"],
    ["disabled-rules", "disabledRules"],
    ["rules", "rules"],
    ["groups", "groups"],
    ["rulesets", "rulesets"],
    ["plugins", "plugins"],
    ["sources", "sources"],
];

// error, then warning, then info — a rule ID named in a later bucket wins (AGENTS.md ## Rules).
function flattenOverride(bucket: { error?: string[]; warning?: string[]; info?: string[] }): Settings["overrides"] {
    const overrides: Record<string, "error" | "warning" | "info"> = {};
    const errorIds = bucket.error ?? [];
    const warningIds = bucket.warning ?? [];
    const infoIds = bucket.info ?? [];
    for (const id of errorIds) overrides[id] = "error";
    for (const id of warningIds) overrides[id] = "warning";
    for (const id of infoIds) overrides[id] = "info";
    return overrides;
}

// `cache.<bucket>.ttl` durations to seconds; a malformed one names its path.
function cacheTtl(cache: Record<string, { ttl?: string | number }>): Settings["cacheTtl"] {
    const out: Partial<Record<BucketName, number>> = {};
    for (const [bucket, { ttl }] of Object.entries(cache)) {
        if (ttl === undefined) continue;
        const seconds = parseDuration(ttl);
        if (seconds === undefined) throw new ConfigError(`org.spiderlint/cache/${bucket}/ttl: invalid duration ${String(ttl)} (expected seconds or 45s, 30m, 24h, 7d)`);
        out[bucket as BucketName] = seconds;
    }
    return out;
}

function fromSubtree(subtree: Record<string, unknown>): Settings {
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
    if (subtree.resolver !== undefined) settings.resolver = parseResolver(subtree.resolver as string);
    if (subtree.cache !== undefined) settings.cacheTtl = cacheTtl(subtree.cache as Record<string, { ttl?: string | number }>);
    if (subtree.override !== undefined) settings.overrides = flattenOverride(subtree.override as { error?: string[]; warning?: string[]; info?: string[] });
    return settings;
}

// Shared settings plus one patch per `sites.<name>`; a site key replaces the shared one whole.
function resolve(raw: unknown): { settings: Settings; sites: Record<string, Settings> } {
    const { sites = {}, ...shared } = validateSubtree(raw) as { sites?: Record<string, Record<string, unknown>> } & Record<string, unknown>;
    if (Object.keys(sites).length > 0 && shared.targets !== undefined) throw new ConfigError("org.spiderlint/targets: with sites, every target belongs to a sites.<name>.targets");
    log.debug({ sites: Object.keys(sites) }, "sites declared");
    return { settings: fromSubtree(shared), sites: Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, fromSubtree(site)])) };
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
