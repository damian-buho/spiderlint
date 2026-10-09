// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// RFC 4180 rows, quoted fields unescaped.
export function parseCsv(csv: string): string[][] {
    const rows: string[][] = [[]];
    for (const match of csv.matchAll(/("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|$)/g)) {
        const [, raw = "", separator] = match;
        rows.at(-1)?.push(raw.startsWith('"') ? raw.slice(1, -1).replaceAll('""', '"') : raw);
        if (separator === "\r\n") rows.push([]);
        else if (separator === "") break;
    }
    return rows;
}
