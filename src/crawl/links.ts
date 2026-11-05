// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { progressCount, progressPhase } from "../progress.ts";
import type { Bucket } from "../cache/index.ts";
import type { Config } from "../config/index.ts";
import type { LinkFacts } from "../facts/types.ts";
import { vendorPath } from "../facts/vendors.ts";
import { log } from "../logger.ts";
import { darknetOf, isProxyDown, isProxyPage } from "./darknet.ts";
import { reason } from "./fetch.ts";
import { PrivateAddress } from "./guard.ts";
import { until } from "./network.ts";
import { probe, type Probe } from "./probe.ts";
import { width } from "./resources.ts";

export type ProbeBucket = Bucket<LinkFacts>;

// A Cloudflare challenge, a Cloudflare edge block that never asked the origin, or LinkedIn’s 999: the answer says nothing about the page.
function isWalled(answer: Probe): boolean {
    const timing = [answer.headers["server-timing"] ?? []].flat().join(",");
    return answer.headers["cf-mitigated"] === "challenge" || (answer.status === 403 && /(^|,)\s*cfOrigin;dur=0(,|$)/.test(timing)) || answer.status === 999;
}

// A HEAD, then a GET when the server refuses HEAD; a network failure is status 0 with its error, and a darknet proxy that did not answer is excluded, since it says nothing about the link.
async function probeOne(href: string, config: Pick<Config, "allowPrivate">, signal: AbortSignal, proxy?: string): Promise<LinkFacts> {
    const options = { host: new URL(href).hostname, allowPrivate: config.allowPrivate, signal, ...(proxy && { proxy }) };
    try {
        const head = await probe(href, { method: "HEAD", redirect: "follow" }, options);
        const answer = head.status === 405 ? await probe(href, { method: "GET", redirect: "follow" }, options) : head;
        const isSilent = proxy !== undefined && isProxyPage(answer.status, answer.headers);
        log.debug({ url: href, status: answer.status, isSilent }, "external link proxy page");
        if (isSilent) return { status: 0, error: `the proxy answers ${answer.status}` };
        const isWall = isWalled(answer);
        log.debug({ url: href, head: head.status, status: answer.status, isWall }, "external link probed");
        return { status: answer.status, method: head.status === 405 ? "GET" : "HEAD", ...(isWall && { walled: true as const }) };
    } catch (error) {
        log.debug({ url: href, error: reason(error) }, "external link unreachable");
        const isUnanswered = proxy !== undefined && isProxyDown(reason(error));
        if (isUnanswered) log.warn({ url: href, error: reason(error) }, "darknet proxy did not answer, link not judged");
        return { status: 0, error: reason(error), ...(error instanceof PrivateAddress && { refused: true as const }), ...(isUnanswered && { excluded: true as const }) };
    }
}

// Whether an answer says anything about its link: not excluded, a vendor’s, refused, walled or rate limited.
export function isJudged(answer: LinkFacts): boolean {
    return !answer.excluded && !answer.vendor && !answer.refused && !answer.walled && answer.status !== 429;
}

// A healthy or walled answer: the only kind worth keeping.
function isKept(answer: LinkFacts): boolean {
    return answer.status > 0 && (answer.status < 400 || answer.walled === true);
}

// One link’s answer, from `bucket` while fresh and still worth keeping; an excluded host, a vendor path or a darknet with no route is never asked, and only a healthy or walled answer is stored.
export async function answerOf(href: string, config: Pick<Config, "allowPrivate" | "linkExclude"> & Partial<Pick<Config, "vendorPaths" | "darknets" | "proxy">>, bucket: ProbeBucket, signal: AbortSignal): Promise<LinkFacts & { cached?: true }> {
    const vendor = config.vendorPaths ? vendorPath(href, "page")?.vendor : undefined;
    log.debug({ url: href, vendor }, "external link vendor");
    if (vendor) return { status: 0, vendor };
    const host = new URL(href).hostname;
    const darknet = darknetOf(host);
    const proxy = darknet && config.darknets?.[darknet];
    const isExcluded = config.linkExclude.some((entry) => host === entry || host.endsWith(`.${entry}`)) || (darknet !== undefined && !proxy && !config.proxy);
    log.debug({ url: href, host, darknet, isProxied: proxy !== undefined, isExcluded }, "external link scoped");
    if (isExcluded) return { status: 0, excluded: true };
    const entry = await bucket.get(href);
    const isReused = entry !== undefined && bucket.isFresh(entry) && isKept(entry.value);
    log.debug({ url: href, isCached: entry !== undefined, isReused }, "external link cache");
    if (isReused) return { ...entry.value, cached: true };
    const answer = { ...(await probeOne(href, config, signal, proxy)), checked: new Date().toISOString() };
    const isStored = isKept(answer);
    log.debug({ url: href, status: answer.status, isStored }, "external link answer");
    if (isStored) await bucket.set(href, answer);
    return answer;
}

// Probes every distinct http(s) link once, at most `maxLinks` of them unless 0, one request at a time per host, hosts in parallel, until `overdue` aborts; a link left unanswered is left out.
export async function probeLinks(links: string[], config: Pick<Config, "allowPrivate" | "concurrency" | "linkExclude" | "vendorPaths"> & Partial<Pick<Config, "maxLinks" | "darknets" | "proxy">>, bucket: ProbeBucket, overdue = new AbortController().signal): Promise<Record<string, LinkFacts>> {
    const named = [...new Set(links)].filter((href) => URL.canParse(href) && /^https?:$/.test(new URL(href).protocol));
    const hrefs = config.maxLinks ? named.slice(0, config.maxLinks) : named;
    if (hrefs.length < named.length) log.info({ named: named.length, probed: hrefs.length, maxLinks: config.maxLinks }, "external links cut at max-links");
    const hosts = Map.groupBy(hrefs, (href) => new URL(href).hostname).values();
    log.debug({ links: hrefs.length }, "external links found");
    const answers: Record<string, LinkFacts> = {};
    let cached = 0;
    let probed = 0;
    progressPhase("probes", hrefs.length);
    const worker = async () => {
        for (const group of hosts) {
            let silent: (LinkFacts & { cached?: true }) | undefined;
            for (const href of group) {
                if (overdue.aborted) return;
                const { cached: isCached, ...answer } = silent ?? (await answerOf(href, config, bucket, overdue));
                if (overdue.aborted) return;
                cached += isCached ? 1 : 0;
                answers[href] = answer;
                const isSilent = silent === undefined && answer.error !== undefined && darknetOf(new URL(href).hostname) !== undefined;
                if (isSilent) log.debug({ url: href, links: group.length, error: answer.error }, "darknet host silent, its other links reuse the answer");
                if (isSilent) silent = answer;
                progressCount((probed += 1));
            }
        }
    };
    const workers = Array.from({ length: Math.min(width(config.concurrency), hrefs.length) }, worker);
    await until(Promise.all(workers), overdue);
    if (overdue.aborted) log.warn({ probed, links: hrefs.length }, "analysis deadline reached, external links left unprobed");
    const all = Object.values(answers);
    const skipped = all.filter((answer) => !isJudged(answer)).length;
    const failed = all.filter((answer) => isJudged(answer) && (answer.status === 0 || answer.status >= 400)).length;
    log.debug({ links: hrefs.length, cached, failed, skipped }, "external links probed");
    return answers;
}
