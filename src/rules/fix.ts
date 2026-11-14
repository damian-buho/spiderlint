// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { getDomain } from "tldts";
import { log } from "../logger.ts";
import type { Finding, RuleMeta } from "./types.ts";

const PLACEHOLDER = /\{(host|domain|origin|url)\}/g;

// The subject a finding names: a page URL, else the bare host or origin a site rule keys it by.
function subject(finding: Finding): Record<string, string> | undefined {
    const href = URL.canParse(finding.url) ? finding.url : `https://${finding.url}`;
    if (!URL.canParse(href)) return undefined;
    const url = new URL(href);
    return { host: url.hostname, domain: getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname, origin: url.origin, url: url.href };
}

// A rule’s fixes in order: `fix` first, then each of `extra`.
export function fixesOf(guide: Pick<RuleMeta, "fix" | "extra"> | undefined): string[] {
    return [guide?.fix, ...(guide?.extra ?? [])].filter((fix): fix is string => fix !== undefined);
}

// A rule’s fix, or the hint for the service the finding’s subject runs on, with `{host}`, `{domain}`, `{origin}` and `{url}` taken from the finding, else shown as `<host>`.
export function fixFor(fix: string, finding?: Finding): string {
    const values = finding && subject(finding);
    if (finding && !values) log.debug({ rule: finding.rule, url: finding.url }, "fix left generic, no subject");
    return (finding?.hint ?? fix).replaceAll(PLACEHOLDER, (_match, name: string) => values?.[name] ?? `<${name}>`);
}

// A DNS record fix as Markdown: the lead sentence, one dashboard field per line as code, then the advice.
export function recordFix(lead: string, fields: Record<string, string>, after = ""): string {
    const lines = Object.entries(fields).map(([name, value]) => `- ${name}: \`${value}\``);
    return [lead, lines.join("\n"), after].filter(Boolean).join("\n\n");
}

// A Markdown fix as plain text lines: code spans unwrapped, a link as its text and URL, blank lines dropped.
export function plainFix(fix: string): string[] {
    return fix
        .replaceAll(/`([^`]+)`/g, "$1")
        .replaceAll(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
        .split("\n")
        .filter((line) => line.trim() !== "");
}
