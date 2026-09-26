// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { log } from "../logger.ts";
import type { Bucket } from "./index.ts";

// What the bucket keeps per run: the facts, absent when the extractor added none.
export interface CachedFacts {
    facts?: unknown;
}

// The part of an extractor its cache entry depends on.
interface Keyed {
    id: string;
    version?: string;
    cached?: false;
}

// Runs each extractor once per (ID, version, URL, body digest), counting runs and cache hits that added facts.
export class ExtractorCache {
    readonly #bucket: Bucket<CachedFacts> | undefined;
    readonly #runs: Record<string, number>;
    readonly #hits: Record<string, number>;

    constructor(bucket: Bucket<CachedFacts> | undefined, runs: Record<string, number> = {}, hits: Record<string, number> = {}) {
        this.#bucket = bucket;
        this.#runs = runs;
        this.#hits = hits;
    }

    // The entry key, undefined for an extractor that opts out or names no version.
    #key(extractor: Keyed, url: string, kind: string, body: string | Uint8Array): string | undefined {
        if (extractor.cached === false || extractor.version === undefined || this.#bucket === undefined) return undefined;
        const digest = createHash("sha256").update(kind).update("\0").update(body).digest("hex");
        return `${extractor.id}\t${extractor.version}\t${url}\t${digest}`;
    }

    // `work`’s facts, from the bucket when the same version already read the same body of `kind` at `url`.
    async run(extractor: Keyed, url: string, kind: string, body: string | Uint8Array, work: () => Promise<unknown>): Promise<unknown> {
        const key = this.#key(extractor, url, kind, body);
        const entry = key === undefined ? undefined : await this.#bucket?.get(key);
        const isHit = entry !== undefined && (this.#bucket?.ttlSeconds === 0 || this.#bucket?.isFresh(entry) === true);
        log.debug({ url, extractor: extractor.id, version: extractor.version, isKeyed: key !== undefined, isHit }, "extractor cache looked up");
        const facts = isHit ? entry.value.facts : await work();
        const tally = isHit ? this.#hits : this.#runs;
        if (facts !== undefined) tally[extractor.id] = (tally[extractor.id] ?? 0) + 1;
        if (!isHit && key !== undefined) await this.#bucket?.set(key, facts === undefined ? {} : { facts });
        return facts;
    }
}
