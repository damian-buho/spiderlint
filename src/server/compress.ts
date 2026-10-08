// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { Duplex } from "node:stream";
import { createBrotliCompress, createDeflate, createGzip, createZstdCompress } from "node:zlib";
import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from "hono/compress";
import type { MiddlewareHandler } from "hono/types";
import { log } from "../logger.ts";

const THRESHOLD = 1024;
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i;
const VARY_ENCODING = /(?:^|,)\s*accept-encoding\s*(?:,|$)/i;

// Codings negotiated, best first; Hono’s own middleware stops at gzip and deflate.
const CODERS = { zstd: createZstdCompress, br: createBrotliCompress, gzip: createGzip, deflate: createDeflate } as const;
const OFFERED = Object.keys(CODERS) as (keyof typeof CODERS)[];

// The best of `offered` the client’s Accept-Encoding names, ties to the earlier one; undefined when it names none.
function preferred(header: string | undefined, offered: readonly string[]): string | undefined {
    if (header === undefined) return undefined;
    const entries = header.split(",").map((part) => {
        const [token = "", ...parameters] = part.trim().split(";");
        const q = Number(
            parameters
                .map((parameter) => parameter.trim())
                .find((parameter) => parameter.startsWith("q="))
                ?.slice(2) ?? 1,
        );
        return { token: token.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    });
    const wildcard = entries.find((entry) => entry.token === "*")?.q ?? 0;
    let [best, bestQ]: [string | undefined, number] = [undefined, 0];
    for (const name of offered) {
        const q = entries.find((entry) => entry.token === name)?.q ?? wildcard;
        if (q > bestQ) [best, bestQ] = [name, q];
    }
    return best;
}

// Answers compressible bodies in the client’s best coding, as Hono’s compress does plus zstd and br.
export function compress(threshold = THRESHOLD): MiddlewareHandler {
    return async function compress(context, next) {
        await next();
        const headers = context.res.headers;
        const type = headers.get("content-type");
        const declared = headers.get("content-length");
        const length = declared === null ? undefined : Number(declared);
        const isUntouched = context.req.method === "HEAD" || context.res.status === 206 || headers.has("content-encoding") || headers.has("transfer-encoding") || NO_TRANSFORM.test(headers.get("cache-control") ?? "");
        if (isUntouched || !type || !COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type) || (length !== undefined && (!Number.isFinite(length) || length < threshold))) return;
        const coding = preferred(context.req.header("accept-encoding"), OFFERED);
        if (coding === undefined || !context.res.body) return;
        log.debug({ coding, path: context.req.path }, "response compressed");
        const pipe = Duplex.toWeb(CODERS[coding as keyof typeof CODERS]()) as TransformStream;
        context.res = new Response(context.res.body.pipeThrough(pipe), context.res);
        context.res.headers.delete("content-length");
        context.res.headers.set("content-encoding", coding);
        const current = context.res.headers.get("vary");
        if (current !== "*" && !(current && VARY_ENCODING.test(current))) context.res.headers.set("vary", current ? `${current}, Accept-Encoding` : "Accept-Encoding");
    };
}
