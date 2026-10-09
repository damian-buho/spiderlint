// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { definePlugin } from "../plugins/types.ts";
import { formatAgent } from "./agent.ts";
import { formatCheckstyle } from "./checkstyle.ts";
import { formatCsv } from "./csv.ts";
import { formatHtml } from "./html.ts";
import { formatHuman } from "./human.ts";
import { formatJson } from "./json.ts";
import { formatSarif } from "./sarif.ts";

// The bundled report formats.
export default definePlugin({
    name: "report",
    formatters: { human: formatHuman, json: formatJson, sarif: formatSarif, checkstyle: formatCheckstyle, csv: formatCsv, html: formatHtml, agent: formatAgent },
});
