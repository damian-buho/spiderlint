// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { LANGUAGES } from "../i18n.ts";
import { log } from "../logger.ts";

interface Link {
    type?: string;
    url?: string;
    preferred?: boolean;
}

// The book’s root URL: the preferred `links[]` entry of type `documentation` in the shipped projectfile, else the first.
export function bookRoot(text: string): string | undefined {
    const links = ((parse(text) as { links?: Link[] } | null)?.links ?? []).filter((link) => link.type === "documentation" && link.url);
    const chosen = links.find((link) => link.preferred) ?? links[0];
    return chosen?.url?.replace(/\/?$/, "/");
}

// The book root read once from the projectfile beside `src/`; none when it is absent or names no documentation link.
const ROOT = (() => {
    try {
        const root = bookRoot(readFileSync(new URL("../../projectfile.yaml", import.meta.url), "utf8"));
        log.debug({ root }, "book root read");
        return root;
    } catch (error) {
        log.debug({ error: String(error) }, "book root not read, rule pages unlinked");
        return;
    }
})();

// The book page of rule `id` in `lang`, the default book when it has none: `<root>/<lang>/pages/rules/<family>.html#<id>`.
export function rulePageUrl(id: string, lang: string, root = ROOT): string | undefined {
    if (!root) return undefined;
    const book = LANGUAGES.includes(lang) ? lang : (LANGUAGES[0] as string);
    return `${root}${book}/pages/rules/${id.split("/", 1)[0] as string}.html#${id}`;
}
