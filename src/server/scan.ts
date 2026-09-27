// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { writeSync } from "node:fs";
import { text } from "node:stream/consumers";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { ConfigError } from "../config/index.ts";
import { fromSubtree } from "../config/policy.ts";
import { validateSubtree } from "../config/schema.ts";
import { audit } from "../index.ts";
import { log } from "../logger.ts";
import { onProgress } from "../progress.ts";
import { formatJson } from "../report/json.ts";
import { PROGRESS_FD } from "./queue.ts";

// Exit codes: 0 the report is on stdout, 2 the settings are invalid, 3 no page was fetched, 4 the run failed.
async function main(): Promise<number> {
    const { url, settings, deny } = JSON.parse(await text(process.stdin)) as { url: string; settings: Record<string, unknown>; deny: string[] };
    onProgress((progress) => writeSync(PROGRESS_FD, `${JSON.stringify(progress)}\n`));
    try {
        const report = await audit({ ...fromSubtree(validateSubtree(settings, "settings")), seeds: [url], cacheMode: "off", denyRules: deny });
        log.info({ url, pages: report.pages.length, findings: report.findings.length }, "scan finished");
        if (report.pages.length === 0) return 3;
        process.stdout.write(formatJson(report));
        return 0;
    } catch (error) {
        log.error({ url, error: error instanceof Error ? error.message : String(error) }, "scan aborted");
        return error instanceof ConfigError ? 2 : 4;
    }
}

setDefaultCACertificates([...getCACertificates("default"), ...getCACertificates("system")]);
process.exitCode = await main();
