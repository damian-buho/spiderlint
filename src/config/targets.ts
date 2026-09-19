// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { log } from "../logger.ts";

const LINK_TYPES = ["homepage", "documentation"];

// undefined when pf-cli is not on PATH, so the caller can fall back to a direct parse.
function linksViaPfCli(document: string): string[] | undefined {
    const targets: string[] = [];
    for (const type of LINK_TYPES) {
        const result = spawnSync("pf-cli", ["get", "-f", document, `links[type=${type}].url`, "--format", "json", "--quiet"], { encoding: "utf8" });
        if (result.error) return undefined;
        if (result.status !== 0) continue;
        const parsed = JSON.parse(result.stdout || "null") as string | string[] | null;
        if (parsed !== null) targets.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    return targets;
}

// No pf-cli: a best-effort direct read, YAML only — same fallback shape as config/policy.ts.
function linksFromYaml(document: string): string[] {
    try {
        const parsed = parseYaml(readFileSync(document, "utf8")) as { links?: { type?: string; url?: string }[] } | null;
        const links = parsed?.links ?? [];
        return links.filter((link) => link.type === "homepage" || link.type === "documentation").map((link) => link.url).filter((url): url is string => typeof url === "string");
    } catch {
        return [];
    }
}

// The projectfile's homepage and documentation links, used when no target was given.
// This is a convenience fallback, never a hard requirement (AGENTS.md ## Configuration, Target).
export function resolveDefaultTargets(document: string): string[] {
    const targets = linksViaPfCli(document) ?? linksFromYaml(document);
    log.debug({ document, targets }, "default targets resolved from links");
    return targets;
}
