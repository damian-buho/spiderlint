// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import { definePlugin } from "./types.ts";

// One URL per line of a file, `-` for stdin, skipping blank lines and `#` comments; they are the whole frontier.
export default definePlugin({
    name: "list",
    sources: [
        {
            id: "list",
            follow: false,
            urls: async (file, signal) => {
                const text = await readFile(file === "-" ? "/dev/stdin" : file, { encoding: "utf8", signal });
                return text
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && !line.startsWith("#"));
            },
        },
    ],
});
