// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { log } from "../logger.ts";
import { ConfigError, type Config } from "./index.ts";
import { validateSubtree } from "./schema.ts";

const SUBTREE = "org.spiderlint";
const DISCOVER_NAMES = ["projectfile.yaml", "projectfile.toml", "projectfile.json"];

export type Settings = Partial<Pick<Config, "seeds" | "fetch" | "scope" | "maxPages" | "maxDepth" | "include" | "exclude" | "robots" | "sitemap" | "fold" | "failOn" | "format" | "disabledRules" | "overrides" | "groups" | "rulesets">>;

// [subtree key, Settings field] — kebab-case document keys to the camelCase Config shape.
// `override` is excluded: its three severity buckets flatten into one field, below.
const KEYS: [string, keyof Settings][] = [
    ["targets", "seeds"],
    ["fetch", "fetch"],
    ["scope", "scope"],
    ["max-pages", "maxPages"],
    ["max-depth", "maxDepth"],
    ["include", "include"],
    ["exclude", "exclude"],
    ["robots", "robots"],
    ["sitemap", "sitemap"],
    ["fold", "fold"],
    ["fail-on", "failOn"],
    ["format", "format"],
    ["disabled-rules", "disabledRules"],
    ["groups", "groups"],
    ["rulesets", "rulesets"],
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

function fromSubtree(subtree: Record<string, unknown>): Settings {
    const settings: Settings = {};
    for (const [key, field] of KEYS) {
        if (subtree[key] !== undefined) (settings as Record<string, unknown>)[field] = subtree[key];
    }
    if (subtree.override !== undefined) settings.overrides = flattenOverride(subtree.override as { error?: string[]; warning?: string[]; info?: string[] });
    return settings;
}

// First recognised projectfile encoding present in the working directory.
function discover(): string | undefined {
    return DISCOVER_NAMES.find((name) => existsSync(name));
}

// null when pf-cli is not on PATH; otherwise the subtree (possibly an error).
function runPfCli(document: string): { raw?: unknown; error?: string } | undefined {
    const result = spawnSync("pf-cli", ["get", "-f", document, SUBTREE, "--format", "json", "--quiet"], { encoding: "utf8" });
    if (result.error) return undefined;
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
export function loadSettings(explicit: string | undefined): { settings: Settings; document: string | undefined } {
    if (explicit !== undefined && !existsSync(explicit)) throw new ConfigError(`config file not found: ${explicit}`);
    const document = explicit ?? discover();
    if (document === undefined) {
        log.debug({}, "no projectfile found, using defaults");
        return { settings: {}, document: undefined };
    }
    const pfResult = runPfCli(document);
    if (pfResult === undefined) {
        if (explicit === undefined) {
            log.info({ document }, "pf-cli not found, skipping projectfile config");
            return { settings: {}, document };
        }
        log.debug({ document }, "pf-cli not found, parsing config file directly");
        return { settings: fromSubtree(validateSubtree(readPlainYaml(document))), document };
    }
    if (pfResult.error !== undefined) throw new ConfigError(`pf-cli: cannot read ${SUBTREE} from ${document}: ${pfResult.error}`);
    log.debug({ document }, "config subtree loaded via pf-cli");
    return { settings: fromSubtree(validateSubtree(pfResult.raw)), document };
}
