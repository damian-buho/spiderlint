// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import picomatch from "picomatch";
import { ConfigError, type GroupConfig } from "../config/index.ts";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";

type Matcher = (facts: Facts) => boolean;

interface Group {
    name: string;
    matchers: Matcher[];
}

// `re:` is a regex, `content-type:` a response type prefix, anything else a picomatch glob.
function matcher(group: string, entry: string): Matcher {
    if (entry.startsWith("re:")) {
        try {
            const regex = new RegExp(entry.slice(3));
            return (facts) => regex.test(facts.url.pathname + facts.url.search);
        } catch (error) {
            throw new ConfigError(`group ${group}: ${entry}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (entry.startsWith("content-type:")) {
        const type = entry.slice("content-type:".length).toLowerCase();
        return (facts) => String(facts.http.headers["content-type"] ?? "").toLowerCase().startsWith(type);
    }
    const glob = picomatch(entry);
    return (facts) => glob(facts.url.pathname + facts.url.search);
}

// Ordered as declared; `default` is appended when the config omits it.
export function compileGroups(groups: Record<string, GroupConfig>): Group[] {
    const compiled = Object.entries(groups)
        .filter(([name]) => name !== "default")
        .map(([name, config]) => ({ name, matchers: (config.match ?? []).map((entry) => matcher(name, entry)) }));
    return [...compiled, { name: "default", matchers: [] }];
}

// First group with a matching entry wins; `default` catches the rest.
export function assignGroup(facts: Facts, groups: Group[]): string {
    for (const group of groups) {
        const matched = group.matchers.findIndex((match) => match(facts));
        if (matched === -1) continue;
        log.debug({ url: facts.url.href, group: group.name, matched }, "group assigned");
        return group.name;
    }
    log.debug({ url: facts.url.href, group: "default" }, "group assigned");
    return "default";
}
