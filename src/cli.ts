#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { audit } from "./index.ts";
import type { FetchMode } from "./config/index.ts";
import { formatHuman } from "./report/human.ts";
import { log } from "./logger.ts";

const USAGE = "usage: spiderlint audit <url…> [--fetch http|browser] [--max-pages N] [--no-robots]";

// Exit codes: 0 clean, 2 usage or abort, 3 no seed fetched.
async function main(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        allowNegative: true,
        options: {
            help: { type: "boolean", short: "h" },
            version: { type: "boolean", short: "V" },
            fetch: { type: "string", default: "http" },
            "max-pages": { type: "string", default: "1" },
            robots: { type: "boolean", default: true },
        },
    });
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    if (values.version) {
        console.log(createRequire(import.meta.url)("../package.json").version);
        return 0;
    }
    const [command, ...seeds] = positionals;
    if (command !== "audit" || seeds.length === 0) {
        console.error(USAGE);
        return 2;
    }
    try {
        const report = await audit({
            seeds,
            fetch: values.fetch as FetchMode,
            maxPages: Number(values["max-pages"]),
            robots: values.robots,
        });
        console.log(formatHuman(report));
        return report.pages.length === 0 ? 3 : 0;
    } catch (error) {
        log.error({ error: error instanceof Error ? error.message : String(error) }, "audit aborted");
        return 2;
    }
}

process.exitCode = await main(process.argv.slice(2));
