// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { getDomain } from "tldts";
import { log } from "../logger.ts";
import type { Finding } from "./types.ts";

const PLACEHOLDER = /\{(host|domain|origin|url)\}/g;

// The subject a finding names: a page URL, else the bare host or origin a site rule keys it by.
function subject(finding: Finding): Record<string, string> | undefined {
    const href = URL.canParse(finding.url) ? finding.url : `https://${finding.url}`;
    if (!URL.canParse(href)) return undefined;
    const url = new URL(href);
    return { host: url.hostname, domain: getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname, origin: url.origin, url: url.href };
}

// A rule’s fix with `{host}`, `{domain}`, `{origin}` and `{url}` taken from the finding, else shown as `<host>`.
export function fixFor(fix: string, finding?: Finding): string {
    const values = finding && subject(finding);
    if (finding && !values) log.debug({ rule: finding.rule, url: finding.url }, "fix left generic, no subject");
    return fix.replaceAll(PLACEHOLDER, (_match, name: string) => values?.[name] ?? `<${name}>`);
}
