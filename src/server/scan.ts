// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { setDefaultCACertificates } from "node:tls";
import { systemCaCertificates } from "../ca.ts";
import { ConfigError } from "../config/index.ts";
import { fromSubtree, stanceOf } from "../config/policy.ts";
import { validateSubtree } from "../config/schema.ts";
import { audit } from "../index.ts";
import { log } from "../logger.ts";
import { onProgress } from "../progress.ts";
import { formatJson } from "../report/json.ts";
import { inSpan, startTelemetry, withTraceCarrier } from "../telemetry.ts";
import { NEVER_SERVED } from "./policy.ts";
import { PREVIEW_FILE, preview } from "./preview.ts";
import { PROGRESS_FD } from "./queue.ts";

// The seed’s preview in `PREVIEW_FILE` before the epoch ms `by`; a failure leaves none and never fails the scan.
async function takePreview(url: string, isPrivateAllowed: boolean, by: number): Promise<void> {
    try {
        const left = Math.max(0, by - Date.now());
        const { image, title } = await preview(url, isPrivateAllowed, AbortSignal.timeout(left));
        await writeFile(PREVIEW_FILE, JSON.stringify({ title, image: image.toString("base64") }));
    } catch (error) {
        log.warn({ url, by, error: error instanceof Error ? error.message : String(error) }, "preview not taken");
    }
}

// Exit codes: 0 the report is on stdout, 2 the settings are invalid, 3 no page was fetched, 4 the run failed.
async function main(): Promise<number> {
    const {
        url,
        settings,
        deny,
        via,
        "content-signals": signals,
        crawlDeadline,
        analysisDeadline,
        previewBy,
        trace,
    } = JSON.parse(await text(process.stdin)) as { url: string; settings: Record<string, unknown>; deny: string[]; via?: string; "content-signals"?: string[]; crawlDeadline: number; analysisDeadline: number; previewBy?: number; trace?: Record<string, string> };
    onProgress((progress) => writeSync(PROGRESS_FD, `${JSON.stringify(progress)}\n`));
    const telemetry = await startTelemetry("spiderlint");
    try {
        const report = await withTraceCarrier(trace, async () =>
            inSpan("scan", { "url.full": url }, async () => audit({ ...fromSubtree(validateSubtree(settings, "settings")), ...(via && { via }), ...(signals && { contentSignals: stanceOf(signals) }), seeds: [url], crawlDeadline, analysisDeadline, cacheMode: "off", denyRules: [...deny, ...NEVER_SERVED] })),
        );
        log.info({ url, pages: report.pages.length, findings: report.findings.length }, "scan finished");
        if (report.pages.length === 0) return 3;
        process.stdout.write(formatJson(report));
        const landed = report.pages.find((page) => page.crawl["discovered-via"] === "seed")?.url.href ?? url;
        log.debug({ url, landed, walled: report.summary.walled }, "preview target chosen");
        if (previewBy && !report.summary.walled) await takePreview(landed, settings["allow-private"] === true, previewBy);
        return 0;
    } catch (error) {
        log.error({ url, error: error instanceof Error ? error.message : String(error) }, "scan aborted");
        return error instanceof ConfigError ? 2 : 4;
    } finally {
        await telemetry?.shutdown();
    }
}

setDefaultCACertificates(systemCaCertificates());
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit -- a phase cut at its deadline may still hold sockets open, and the runner must not wait for them
process.exit(await main());
