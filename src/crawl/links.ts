// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Bucket } from "../cache/index.ts";
import type { Config } from "../config/index.ts";
import type { LinkFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { reason } from "./fetch.ts";
import { PrivateAddress } from "./guard.ts";
import { probe, type Probe } from "./probe.ts";
import { width } from "./resources.ts";

export type ProbeBucket = Bucket<LinkFacts>;

// A Cloudflare challenge or LinkedIn’s 999: the answer says nothing about the page.
function isWalled(answer: Probe): boolean {
    return answer.headers["cf-mitigated"] === "challenge" || answer.status === 999;
}

// A HEAD, then a GET when the server refuses HEAD; a network failure is status 0 with its error.
async function probeOne(href: string, config: Pick<Config, "allowPrivate">, signal: AbortSignal): Promise<LinkFacts> {
    const options = { host: new URL(href).hostname, allowPrivate: config.allowPrivate, signal };
    try {
        const head = await probe(href, { method: "HEAD", redirect: "follow" }, options);
        const answer = head.status === 405 ? await probe(href, { method: "GET", redirect: "follow" }, options) : head;
        const isWall = isWalled(answer);
        log.debug({ url: href, head: head.status, status: answer.status, isWall }, "external link probed");
        return { status: answer.status, method: head.status === 405 ? "GET" : "HEAD", ...(isWall && { walled: true as const }) };
    } catch (error) {
        log.debug({ url: href, error: reason(error) }, "external link unreachable");
        return { status: 0, error: reason(error), ...(error instanceof PrivateAddress && { refused: true as const }) };
    }
}

// Whether an answer says anything about its link: not excluded, refused, walled or rate limited.
export function isJudged(answer: LinkFacts): boolean {
    return !answer.excluded && !answer.refused && !answer.walled && answer.status !== 429;
}

// One link’s answer, from `bucket` while fresh; an excluded host is never asked, and only a healthy or walled answer is stored.
export async function answerOf(href: string, config: Pick<Config, "allowPrivate" | "linkExclude">, bucket: ProbeBucket, signal: AbortSignal): Promise<LinkFacts & { cached?: true }> {
    const host = new URL(href).hostname;
    const isExcluded = config.linkExclude.some((entry) => host === entry || host.endsWith(`.${entry}`));
    log.debug({ url: href, host, isExcluded }, "external link scoped");
    if (isExcluded) return { status: 0, excluded: true };
    const entry = await bucket.get(href);
    if (entry && bucket.isFresh(entry)) return { ...entry.value, cached: true };
    const answer = await probeOne(href, config, signal);
    const isStored = answer.status > 0 && (answer.status < 400 || answer.walled === true);
    log.debug({ url: href, status: answer.status, isStored }, "external link answer");
    if (isStored) await bucket.set(href, answer);
    return answer;
}

// Probes every distinct http(s) link once, one request at a time per host, hosts in parallel.
export async function probeLinks(links: string[], config: Pick<Config, "allowPrivate" | "concurrency" | "linkExclude">, bucket: ProbeBucket): Promise<Record<string, LinkFacts>> {
    const hrefs = [...new Set(links)].filter((href) => URL.canParse(href) && /^https?:$/.test(new URL(href).protocol));
    const hosts = Map.groupBy(hrefs, (href) => new URL(href).hostname).values();
    log.info({ links: hrefs.length }, "external links found");
    const answers: Record<string, LinkFacts> = {};
    const signal = new AbortController().signal;
    let cached = 0;
    const worker = async () => {
        for (const group of hosts) {
            for (const href of group) {
                const { cached: isCached, ...answer } = await answerOf(href, config, bucket, signal);
                cached += isCached ? 1 : 0;
                answers[href] = answer;
            }
        }
    };
    const workers = Array.from({ length: Math.min(width(config.concurrency), hrefs.length) }, worker);
    await Promise.all(workers);
    const all = Object.values(answers);
    const skipped = all.filter((answer) => !isJudged(answer)).length;
    const failed = all.filter((answer) => isJudged(answer) && (answer.status === 0 || answer.status >= 400)).length;
    log.info({ links: hrefs.length, cached, failed, skipped }, "external links probed");
    return answers;
}
