// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const { SPIDERLINT_CONFIG: _config, FORCE_COLOR: _force, ...ENVIRONMENT } = process.env;

export interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

// Runs the real binary outside any projectfile, with a private user cache and `extra` environment, asynchronously so the in-process fixture keeps answering.
export function spiderlintWith(extra: NodeJS.ProcessEnv, directory: string, ...flags: string[]): Promise<Run> {
    return new Promise((resolve) => {
        execFile(process.execPath, ["--experimental-strip-types", CLI, ...flags], { cwd: directory, env: { ...ENVIRONMENT, SPIDERLINT_LOG_FORMAT: "json", XDG_CACHE_HOME: path.join(directory, "cache"), ...extra } }, (error, stdout, stderr) => {
            resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr: error && typeof error.code !== "number" ? `${stderr}\nchild ended by ${String(error.signal ?? error.code)}` : stderr });
        });
    });
}

// `run`’s stdout as JSON, failing on its exit code and stderr when it printed nothing.
export function parsed(run: Run) {
    assert.notEqual(run.stdout.trim(), "", `exit ${run.code}, empty stdout; stderr tail:\n${run.stderr.slice(-4000)}`);
    return JSON.parse(run.stdout);
}

export function spiderlint(directory: string, ...flags: string[]): Promise<Run> {
    return spiderlintWith({}, directory, ...flags);
}

// The html-validate findings of a JSON audit of `origin`.
export async function findingsOf(directory: string, origin: string, ...flags: string[]): Promise<{ occurrences?: number }[]> {
    const run = await spiderlint(directory, "audit", `${origin}/`, "--format", "json", "--fail-on", "never", "--rules", "html-validate", ...flags);
    return parsed(run).findings as { occurrences?: number }[];
}

// An audit of `origin` under the suggestions preset, failing on info.
export function suggested(directory: string, origin: string, ...flags: string[]): Promise<Run> {
    return spiderlint(directory, "audit", `${origin}/`, "--rules", "suggestions", "--fail-on", "info", ...flags);
}

export function ruleIdsOf(run: Run): string[] {
    return (parsed(run) as { id: string }[]).map((rule) => rule.id);
}
