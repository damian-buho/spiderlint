// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Finding, Make } from "../rules/types.ts";

// One message a markup linter reported on a page, with where it sits and the tag there.
export interface MarkupMessage {
    rule: string;
    message: string;
    line: number;
    column: number;
    selector?: string;
    source?: string;
}

// One finding per distinct message of linter rule `id` under `page[extractor].messages`, its locations as the value; `fix` is the upstream rule description.
export function messageRule(extractor: string, prefix: string, id: string, documentation: string, fix?: string): Make {
    const ruleId = `${prefix}${id}`;
    return (severity) => ({
        meta: { id: ruleId, severity, scope: "page", facts: [`${extractor}.messages`], docs: documentation, ...(fix && { fix }) },
        check(page: Facts) {
            const facts = page[extractor] as { messages: MarkupMessage[] } | undefined;
            if (!facts) return;
            const byMessage = Map.groupBy(facts.messages.filter((message) => message.rule === id), (message) => message.message);
            log.debug({ rule: ruleId, url: page.url.href, messages: byMessage.size }, "markup messages judged");
            const locate = (hits: MarkupMessage[]) => hits.map(({ line, column, selector }) => ({ line, column, ...(selector && { selector }) }));
            const lines = (hits: MarkupMessage[]) => hits.map(({ line, column, selector, source }) => [`${line}:${column}`, selector, source].filter(Boolean).join(" "));
            return byMessage.entries().map(([message, hits]): Finding => ({ rule: ruleId, severity, scope: "page", url: page.url.href, group: page.group, message, value: locate(hits), locations: lines(hits) })).toArray();
        },
    });
}
