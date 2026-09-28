// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { PassThrough, type Readable, type Transform } from "node:stream";
import zlib from "node:zlib";
import { log } from "../logger.ts";

// Response fields Crawlee reads off the stream it parses.
const FIELDS = ["statusCode", "statusMessage", "headers", "httpVersion", "rawHeaders", "url", "request", "complete"];

// Types whose body becomes facts; any other type is judged by its headers alone.
const PARSED = /^(?:text\/html|application\/xhtml\+xml|(?:text|application)\/xml|application\/json|application\/[\w.-]+\+(?:xml|json))$/;

export interface Capped {
    stream: Readable;
    isTruncated(): boolean;
}

// A missing content type is parsed, as Crawlee then guesses from the URL.
export function isParsed(contentType: string | undefined): boolean {
    const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
    return !type || PARSED.test(type);
}

// `body` under `contentType` in place of `source`’s own, its other response fields kept.
export function replayed(source: Readable, body: string, contentType: string): Readable {
    const stream = new PassThrough();
    for (const field of FIELDS) Object.assign(stream, { [field]: (source as unknown as Record<string, unknown>)[field] });
    Object.assign(stream, { headers: { ...(source as unknown as { headers: Record<string, unknown> }).headers, "content-type": contentType } });
    source.resume();
    stream.end(body);
    return stream;
}

// The codings a page request advertises, each one `decoder` undoes.
export const ACCEPT_ENCODING = "gzip, deflate, br, zstd";

// Each known coding’s decoder, tolerant of a stream cut short.
const DECODERS: Record<string, () => Transform> = {
    gzip: () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    "x-gzip": () => zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    deflate: () => zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }),
    br: () => zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }),
    zstd: () => zlib.createZstdDecompress(),
};

// A stream undoing one `Content-Encoding`; undefined for identity or a coding it does not know.
export function decoder(encoding: string | undefined): Transform | undefined {
    return DECODERS[encoding?.trim().toLowerCase() ?? ""]?.();
}

// The response got wraps once it read every declared byte, which a parse error on bytes past them leaves intact.
function completed(source: Readable): Readable | undefined {
    const response = (source as unknown as { response?: Readable & { complete?: boolean } }).response;
    return response?.complete ? response : undefined;
}

// At most `max` decoded bytes of `source`, which is destroyed once the cap is reached.
export function capped(source: Readable, max: number): Capped {
    const stream = new PassThrough();
    for (const field of FIELDS) Object.assign(stream, { [field]: (source as unknown as Record<string, unknown>)[field] });
    let isCut = false;
    const unzip = max === 0 ? undefined : decoder([(source as unknown as { headers?: Record<string, unknown> }).headers?.["content-encoding"]].flat()[0] as string | undefined);
    const body = unzip ? source.pipe(unzip) : source;
    const cut = () => {
        isCut = true;
        source.destroy();
        unzip?.destroy();
        stream.end();
    };
    if (max === 0) {
        cut();
        return { stream, isTruncated: () => isCut };
    }
    let seen = 0;
    const take = (chunk: Buffer) => {
        if (isCut) return;
        const room = max - seen;
        seen += chunk.length;
        stream.write(chunk.subarray(0, room));
        if (seen >= max) cut();
    };
    // A failure after every declared byte arrived ends the body with the bytes got never passed on; any other destroys it.
    const fail = (error: Error) => {
        const response = completed(source);
        log.debug({ error: error.message, isComplete: response !== undefined, seen }, "body stream failed");
        if (!response) return stream.destroy(error);
        const rest = (response.read() as Buffer | null) ?? Buffer.alloc(0);
        if (unzip) return void unzip.end(rest);
        take(rest);
        stream.end();
    };
    body.on("data", take);
    body.on("end", () => stream.end());
    source.on("error", fail);
    unzip?.on("error", (error) => stream.destroy(error));
    if (source.errored) fail(source.errored);
    return { stream, isTruncated: () => isCut };
}
