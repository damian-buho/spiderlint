// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { CheerioCrawlingContext } from "crawlee";
import { log } from "../logger.ts";
import type { HtmlFacts, ParityFacts, ParitySide } from "./types.ts";

type CheerioAPI = CheerioCrawlingContext["$"];

// Characters of visible text in `<main>`, else `<body>`; `<noscript>` counts only where no script runs.
export function mainText($: CheerioAPI, isScripted: boolean): number {
    const root = $($("main").length > 0 ? "main" : "body")
        .first()
        .clone();
    root.find(`script, style, template${isScripted ? ", noscript" : ""}`).remove();
    return root.text().replaceAll(/\s+/g, " ").trim().length;
}

// What a crawler reading one render of the page sees.
function side(html: HtmlFacts, text: number): ParitySide {
    const { title, canonical, h1 } = html;
    const description = html.meta.description;
    return { ...(title && { title }), ...(description && { description }), ...(canonical && { canonical }), h1, text, links: html.links.internal.length };
}

// The raw HTML and the rendered DOM of one page side by side, with what only the render carries under `missing`.
export function parityFacts(href: string, $raw: CheerioAPI, raw: HtmlFacts, $rendered: CheerioAPI, rendered: HtmlFacts): ParityFacts {
    const before = side(raw, mainText($raw, false));
    const after = side(rendered, mainText($rendered, true));
    const missing: ParityFacts["missing"] = {};
    for (const key of ["title", "description", "canonical"] as const) {
        const [value, served] = [after[key], before[key]];
        if (value && !served) missing[key] = value;
    }
    if (after.h1.length > 0 && before.h1.length === 0) missing.h1 = after.h1;
    const known = new Set(raw.links.internal);
    const links = rendered.links.internal.filter((link) => !known.has(link));
    if (links.length > 0) missing.links = links;
    const share = after.text > 0 ? Math.round((before.text / after.text) * 100) / 100 : undefined;
    log.debug({ url: href, missing: Object.keys(missing), rawText: before.text, renderedText: after.text, share }, "raw and rendered html compared");
    return { raw: before, rendered: after, missing, ...(share !== undefined && { "text-share": share }) };
}
