// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { log } from "../logger.ts";
import type { DetectedFacts, HtmlFacts, LanguageGuess } from "./types.ts";

// Characters below which a title or description is too short to identify.
export const MIN_LENGTH = 24;

type Detector = (typeof import("eld/extrasmall"))["eld"];
// The detector once loaded; absent until a run needs it.
const loaded: { detector?: Detector } = {};

// Loads eld’s extrasmall database once, only for a run whose rules read `html.detected`.
export async function loadDetector(): Promise<void> {
    const module = loaded.detector ? undefined : await import("eld/extrasmall");
    loaded.detector ??= module?.eld;
    log.debug({ languages: Object.keys(loaded.detector?.info().Languages ?? {}).length, isFresh: module !== undefined }, "language detector loaded");
}

// The language of one string with its top score, when long enough and the detector names one.
function guess(text: string | undefined): LanguageGuess | undefined {
    const trimmed = text?.trim() ?? "";
    if (!loaded.detector || trimmed.length < MIN_LENGTH) return undefined;
    const result = loaded.detector.detect(trimmed);
    if (!result.language) return undefined;
    const confidence = Math.round((result.getScores()[result.language] ?? 0) * 100) / 100;
    return { language: result.language, confidence, reliable: result.isReliable() };
}

// The detected language of a page’s title and meta description; undefined before the detector loads.
export function detectedFacts(html: HtmlFacts): DetectedFacts | undefined {
    if (!loaded.detector) return undefined;
    const [title, description] = [guess(html.title), guess(html.meta.description)];
    return { ...(title && { title }), ...(description && { description }) };
}
