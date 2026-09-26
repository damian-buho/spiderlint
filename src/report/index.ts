// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { definePlugin } from "../plugins/types.ts";
import { formatCheckstyle } from "./checkstyle.ts";
import { formatCsv } from "./csv.ts";
import { formatHuman } from "./human.ts";
import { formatJson } from "./json.ts";
import { formatSarif } from "./sarif.ts";

// The bundled report formats.
export default definePlugin({
    name: "report",
    formatters: { human: formatHuman, json: formatJson, sarif: formatSarif, checkstyle: formatCheckstyle, csv: formatCsv },
});
