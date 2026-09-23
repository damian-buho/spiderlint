// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { PassThrough, type Readable } from "node:stream";

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

// At most `max` bytes of `source`, which is destroyed once the cap is reached.
export function capped(source: Readable, max: number): Capped {
    const stream = new PassThrough();
    for (const field of FIELDS) Object.assign(stream, { [field]: (source as unknown as Record<string, unknown>)[field] });
    let isCut = false;
    const cut = () => {
        isCut = true;
        source.destroy();
        stream.end();
    };
    if (max === 0) {
        cut();
        return { stream, isTruncated: () => isCut };
    }
    let seen = 0;
    source.on("data", (chunk: Buffer) => {
        if (isCut) return;
        const room = max - seen;
        seen += chunk.length;
        stream.write(chunk.subarray(0, room));
        if (seen >= max) cut();
    });
    source.on("end", () => stream.end());
    source.on("error", (error) => stream.destroy(error));
    return { stream, isTruncated: () => isCut };
}
