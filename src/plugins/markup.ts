// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { load } from "cheerio";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule, resolve } from "../rules/builtin.ts";
import { definePlugin } from "./types.ts";

const ID = "markup";

export interface MarkupFacts {
    // Anchors to an `hreflang` alternate, with the language they declare.
    switcher: { href: string; lang?: string; hreflang?: string }[];
    videos: { src?: string; tracks: string[]; muted: boolean; controls: boolean }[];
}

// Language-switcher anchors and videos of an HTML page.
async function extract(page: Facts, body: string): Promise<MarkupFacts | undefined> {
    if (!page.html) return;
    const alternates = new Set(page.html.hreflang.map((alternate) => resolve(alternate.href, page.url.href)));
    const self = resolve(page.url.href, page.url.href);
    const $ = load(body);
    const switcher = $("a[href]").get().flatMap((element) => {
        const [href, lang, hreflang] = [resolve(String($(element).attr("href")), page.url.href), $(element).attr("lang"), $(element).attr("hreflang")];
        // A link to the page itself stays in its language, so it never switches.
        return href !== self && alternates.has(href) ? [{ href, ...(lang !== undefined && { lang }), ...(hreflang !== undefined && { hreflang }) }] : [];
    });
    const videos = $("video").get().map((element) => {
        const video = $(element);
        const source = video.attr("src") ?? video.find("source[src]").first().attr("src");
        return { ...(source !== undefined && { src: source }), tracks: video.find("track").map((_, track) => String($(track).attr("kind") ?? "subtitles").toLowerCase()).get(), muted: video.is("[muted]"), controls: video.is("[controls]") };
    });
    log.debug({ url: page.url.href, alternates: alternates.size, switcher: switcher.length, videos: videos.length }, "markup read");
    return { switcher, videos };
}

const markupOf = (page: Facts) => page[ID] as MarkupFacts | undefined;

// Whether two language tags agree, one being the other or a subtag-wise prefix of it.
function isAgreeing(declared: string, expected: string): boolean {
    const [a, b] = [declared.toLowerCase(), expected.toLowerCase()];
    return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

const langSwitcher = pageRule("markup/lang-switcher", [`${ID}.switcher`, "html.hreflang"], (page) => {
    const facts = markupOf(page);
    if (!facts || !page.html) return;
    const locations = facts.switcher.flatMap(({ href, lang, hreflang }) => {
        const expected = page.html?.hreflang.filter((alternate) => resolve(alternate.href, page.url.href) === href && alternate.lang !== "x-default").map((alternate) => alternate.lang) ?? [];
        if (expected.length === 0) return [];
        const pageLang = page.html?.lang;
        if (pageLang && expected.every((tag) => isAgreeing(tag, pageLang))) return [];
        const declared = lang ?? hreflang;
        if (declared && expected.some((tag) => isAgreeing(declared, tag))) return [];
        return [`${href} ${declared ? `declares ${declared}, not` : "declares no lang for"} ${expected.join(", ")}`];
    });
    return locations.length === 0 ? [] : [{ message: `${locations.length} language switcher link${locations.length === 1 ? " does" : "s do"} not declare the language ${locations.length === 1 ? "it leads" : "they lead"} to`, value: locations, locations }];
}, { docs: "https://www.w3.org/International/questions/qa-link-lang", fix: "Give each switcher link `lang` and `hreflang` equal to its target’s language, and write its text in that language." });

const captions = pageRule("markup/captions", [`${ID}.videos`], (page) => {
    const facts = markupOf(page);
    if (!facts) return;
    const bare = facts.videos.filter((video) => !(video.muted && !video.controls) && video.tracks.every((kind) => kind !== "captions" && kind !== "subtitles"));
    return bare.length === 0 ? [] : [{ message: `${bare.length} <video> without captions or subtitles`, value: bare, locations: bare.map((video) => video.src ?? "<video>") }];
}, { docs: "https://www.w3.org/WAI/media/av/captions/", fix: "Add `<track kind=\"captions\" src=\"….vtt\" srclang=\"…\">` to each video with speech; a muted decorative loop without controls is exempt." });

// The input `type` or `inputmode` an autocomplete field name calls for.
const EXPECTED: Record<string, string> = { email: "email", tel: "tel", "tel-national": "tel", "tel-local": "tel", url: "url", photo: "url", impp: "url" };

const inputType = pageRule("markup/input-type", ["html.inputs"], (page) => {
    if (!page.html) return;
    const locations = page.html.inputs.flatMap(({ type, autocomplete, inputmode }) => {
        const field = autocomplete?.toLowerCase().split(/\s+/).find((token) => Object.hasOwn(EXPECTED, token));
        const expected = field && EXPECTED[field];
        return !expected || type === expected || inputmode === expected ? [] : [`autocomplete=${field} on type=${type}${inputmode ? ` inputmode=${inputmode}` : ""}`];
    });
    return locations.length === 0 ? [] : [{ message: `${locations.length} <input> whose type does not match the autocomplete field, so phones show the wrong keyboard`, value: locations, locations }];
}, { docs: "https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill-field", fix: "Set `type` (or `inputmode`) to what the autocomplete field holds: `email`, `tel` or `url`." });

export default definePlugin({
    name: "markup",
    extractors: [{ id: ID, extract }],
    rules: { "markup/lang-switcher": langSwitcher, "markup/captions": captions, "markup/input-type": inputType },
    presets: {
        markup: {
            description: "Markup the crawl can judge alone: language switcher links, video captions, input types matching their autocomplete",
            rules: { "markup/lang-switcher": { severity: "warning", score: 4.8 }, "markup/captions": { severity: "warning", score: 6 }, "markup/input-type": { severity: "warning", score: 4.4 } },
        },
    },
});
