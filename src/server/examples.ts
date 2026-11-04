// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { log } from "../logger.ts";
import { enqueue, type Jobs } from "./jobs.ts";
import { admit, Refusal, type Admitted } from "./policy.ts";
import { dropExample, exampleReports, PREFIX, previewKey } from "./queue.ts";

const TICK_MS = 60_000;
// Held by the API replica whose tick runs, so replicas queue no example twice.
const LOCK = `${PREFIX}:examples:tick`;
// What scheduling examples reads: the queue, its Redis and the live settings.
type Scheduling = Pick<Jobs, "queue" | "redis" | "settings">;

// The configured sites as their policies admit them, in the order configured; a refused one is logged and left out.
function admitted(jobs: Scheduling): Admitted[] {
    const settings = jobs.settings();
    return settings.examples.sites.flatMap((url) => {
        try {
            return [admit({ url }, settings)];
        } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            log.warn({ url, code: error.code, error: error.message }, "example refused by its policy");
            return [];
        }
    });
}

// Forgets the examples of hosts no longer configured, removing their scans and previews.
async function prune(jobs: Scheduling, hosts: Set<string>, known: Iterable<string>): Promise<void> {
    for (const host of known) {
        if (hosts.has(host)) continue;
        const id = await dropExample(jobs.redis, host);
        if (id) await Promise.all([jobs.queue.remove(id), jobs.redis.del(previewKey(id))]);
        log.info({ host, job: id }, "unconfigured example removed");
    }
}

// Queues the stalest due example while no scan waits and a worker stays free for visitors, at most one a tick and one a host per `every`, finished or not; returns its job ID.
export async function tick(jobs: Scheduling, now = Date.now()): Promise<string | undefined> {
    const {
        examples: { every },
        workers,
    } = jobs.settings();
    const sites = admitted(jobs);
    const known = await exampleReports(jobs.redis);
    await prune(jobs, new Set(sites.map((site) => site.host)), known.keys());
    const { waiting = 0, prioritized = 0, active = 0 } = await jobs.queue.getJobCounts("waiting", "prioritized", "active");
    const due = sites.filter((site) => now - (known.get(site.host)?.finished ?? 0) >= every * 1000).toSorted((a, b) => (known.get(a.host)?.finished ?? 0) - (known.get(b.host)?.finished ?? 0));
    const slots = Math.max(1, workers - 1);
    log.debug({ sites: sites.length, due: due.length, waiting, prioritized, active, slots }, "examples checked");
    if (waiting + prioritized > 0 || active >= slots) return undefined;
    for (const site of due) {
        const queued = `${PREFIX}:examples:queued:${site.host}`;
        if ((await jobs.redis.set(queued, now, "EX", Math.max(every, 2 * site.policy.scanTimeout), "NX")) !== "OK") continue;
        const job = await enqueue(jobs, site, "", true);
        log.info({ job: job.id, host: site.host, last: known.get(site.host)?.finished }, "example queued");
        return job.id;
    }
    return undefined;
}

// Ticks every minute while examples are configured, on the replica that takes the lock; returns the stop.
export function startExamples(jobs: Scheduling): () => void {
    const run = async () => {
        if (jobs.settings().examples.sites.length === 0) return;
        if ((await jobs.redis.set(LOCK, process.pid, "PX", TICK_MS - 1000, "NX")) !== "OK") {
            log.debug({ lock: LOCK }, "examples ticked by another replica");
            return;
        }
        await tick(jobs);
    };
    const timer = setInterval(() => void run().catch((error: unknown) => log.warn({ error: String(error) }, "examples tick failed")), TICK_MS);
    log.info({ everyMs: TICK_MS }, "examples scheduler started");
    return () => clearInterval(timer);
}
