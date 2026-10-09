// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Datum, Finding } from "../rules/types.ts";

// C0 and C1 controls, newline and tab included, and the bidi overrides and isolates.
const UNPRINTABLE = /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

// Site text with every control shown as a `\u{…}` escape, so it can neither drive a terminal nor forge a line.
export function printable(text: string): string {
    return text.replaceAll(UNPRINTABLE, (char) => String.raw`\u{${(char.codePointAt(0) as number).toString(16)}}`);
}

// Every string datum of a record printable.
function datums(data: Record<string, Datum>): Record<string, Datum> {
    return Object.fromEntries(Object.entries(data).map(([key, datum]) => [key, typeof datum === "string" ? printable(datum) : datum]));
}

// A finding whose site-derived strings are all printable.
export function printableFinding(finding: Finding): Finding {
    const lines = (values: string[] | undefined) => values?.map((value) => printable(value));
    return {
        ...finding,
        url: printable(finding.url),
        message: printable(finding.message),
        ...(finding.locations && { locations: lines(finding.locations) }),
        ...(finding.urls && { urls: lines(finding.urls) }),
        ...(finding.samples && { samples: lines(finding.samples) }),
        ...(finding.variables && { variables: datums(finding.variables) }),
        ...(finding.data && { data: Object.fromEntries(Object.entries(finding.data).map(([url, data]) => [printable(url), datums(data)])) }),
        ...(finding.evidence && { evidence: finding.evidence.map((read) => ({ ...read, key: printable(read.key) })) }),
        ...(finding.sampleLocations && { sampleLocations: Object.fromEntries(Object.entries(finding.sampleLocations).map(([url, found]) => [printable(url), lines(found) as string[]])) }),
    };
}
