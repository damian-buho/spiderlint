// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from "node:fs/promises";
import Validator, { type ValidationIssue, type ValidationPath } from "@adobe/structured-data-validator";
import WebAutoExtractor, { type ExtractionError } from "@marbec/web-auto-extractor";
import type { Facts } from "../facts/types.ts";
import { log } from "../logger.ts";
import type { Guide } from "../rules/builtin.ts";
import { said } from "../rules/message.ts";
import type { Finding, Make, Severity } from "../rules/types.ts";

// The wrapped tool, @adobe/structured-data-validator: every page’s JSON-LD, Microdata and RDFa judged against the schema.org vocabulary and Google’s rich-result requirements.
const ID = "structureddatavalidator";

const VOCABULARY = new URL("../../vendors/schemaorg-all-https.jsonld", import.meta.url);
// The schema.org vocabulary it names, parsed once per process.
const loaded: { vocabulary?: Promise<unknown> } = {};
const schemaOrg = async () => JSON.parse(await readFile(VOCABULARY, "utf8")) as unknown;

// At most this many issues per page, so one pathological page cannot flood the store.
const CAP = 200;

// One issue the validator or its extractor reported, mapped to the rule that judges it.
export interface ValidationMessage {
    // The spiderlint rule the issue maps to.
    rule: string;
    // `error` and `warning` follow the upstream issue; `info` marks the optional-field advice the tool reports as a warning.
    level: Exclude<Severity, "off">;
    message: string;
    // The syntax and the path inside it, `jsonld Product[0].offers[0]`.
    selector: string;
    line?: number;
    column?: number;
}

export interface StructuredValidationFacts {
    messages: ValidationMessage[];
}

// Line and column of a character offset, both 1-based, memoized since one root item spans many issues.
function positioner(body: string): (offset: number) => [line: number, column: number] {
    const seen = new Map<number, [number, number]>();
    return (offset) => {
        const known = seen.get(offset);
        if (known) return known;
        const found: [number, number] = [body.slice(0, offset).split("\n").length, offset - body.lastIndexOf("\n", offset - 1)];
        seen.set(offset, found);
        return found;
    };
}

// A path through the extracted data, as `Product[0].itemListElement[1]`.
const locate = (path: ValidationPath[]) => path.map((element) => `${element.property ?? element.type ?? ""}${element.index === undefined ? "" : `[${element.index}]`}`).join(".");

// The rule an upstream issue maps to: the vocabulary checks split by what they name, everything else is a rich-result requirement.
function issueOf(issue: ValidationIssue, at: (offset: number) => [number, number]): ValidationMessage {
    let rule = "structured-data/rich-result/invalid";
    if (issue.errorType === "schemaOrg" && issue.fieldNames[0] === "@type") rule = "structured-data/type/unknown";
    else if (issue.errorType === "schemaOrg") rule = "structured-data/property/unknown";
    // Adobe reports a missing optional field as a warning; it is advice, so it never fails the check.
    const advisory = issue.severity === "WARNING" && issue.issueMessage.startsWith("Missing field ") && issue.issueMessage.endsWith(" (optional)");
    const [line, column] = issue.location === undefined ? [] : at(Number(issue.location.split(",", 1)[0]));
    return {
        rule,
        level: issue.severity === "ERROR" ? "error" : advisory ? "info" : "warning",
        message: issue.issueMessage,
        selector: `${issue.dataFormat} ${locate(issue.path)}${issue.fieldNames.length > 0 ? `: ${issue.fieldNames.join(", ")}` : ""}`,
        ...(line !== undefined && { line, column }),
    };
}

// A parse error of the extractor maps to the defect it names; a block that does not parse at all is `structured-data/json-ld/invalid`’s finding already.
const ERROR_RULES: [RegExp, string][] = [
    [/^(?:JSON-LD object is empty|JSON-LD object missing @type attribute)$/, "structured-data/type/missing"],
    [/^JSON-LD object missing @context attribute$/, "structured-data/context/missing"],
    [/itemtype missing valid context$/, "structured-data/context/invalid"],
];

function errorOf(error: ExtractionError, at: (offset: number) => [number, number]): ValidationMessage | undefined {
    if (error.message === "Could not parse JSON-LD") return;
    const rule = ERROR_RULES.find(([pattern]) => pattern.test(error.message))?.[1] ?? "structured-data/rich-result/invalid";
    const [line, column] = error.sourceCodeLocation === undefined ? [] : at(error.sourceCodeLocation.startOffset);
    return { rule, level: "error", message: error.message, selector: error.format, ...(line !== undefined && { line, column }) };
}

// Validates a page’s structured data against the schema.org vocabulary and Google’s rich-result requirements; a truncated body is skipped, since its cut-off markup would all fail.
async function extract(page: Facts, body: string): Promise<StructuredValidationFacts | undefined> {
    if (!page.html || page.http.size.truncated || !/\bitemscope\b|\btypeof\s*=|application\/ld\+json/i.test(body)) return;
    const at = positioner(body);
    const parsed = new WebAutoExtractor({ addLocation: true, embedSource: ["rdfa", "microdata"] }).parse(body);
    const issues = await new Validator(await (loaded.vocabulary ??= schemaOrg())).validate({ jsonld: parsed.jsonld, microdata: parsed.microdata, rdfa: parsed.rdfa });
    const messages = [
        ...issues.map((issue) => issueOf(issue, at)),
        ...parsed.errors.flatMap((error) => {
            const message = errorOf(error, at);
            return message ? [message] : [];
        }),
    ].slice(0, CAP);
    // A page with valid structured data carries empty facts, so its check counts as passed rather than skipped.
    const hasData = messages.length > 0 || Object.keys(parsed.jsonld).length + Object.keys(parsed.microdata).length + Object.keys(parsed.rdfa).length > 0;
    log.debug({ url: page.url.href, issues: issues.length, errors: parsed.errors.length, hasData }, "structured data validated");
    return hasData ? { messages } : undefined;
}

// One finding per distinct issue of the class `id`, each occurrence a location; `escalate` keeps the tool’s own error level and its optional-field advice whatever the rule is set to.
function issueRule(id: string, guide: Guide, options: { escalate?: true } = {}): Make {
    return (severity) => ({
        meta: { id, severity, scope: "page", facts: [`${ID}.messages`], ...guide },
        check(page: Facts) {
            const facts = page[ID] as StructuredValidationFacts | undefined;
            if (!facts) return;
            const byMessage = Map.groupBy(
                facts.messages.filter((message) => message.rule === id),
                (message) => `${message.level} ${message.message}`,
            );
            log.debug({ rule: id, url: page.url.href, messages: byMessage.size }, "validation issues judged");
            return byMessage
                .entries()
                .map(([key, hits]): Finding => {
                    const level = key.split(" ", 1)[0] as Exclude<Severity, "off">;
                    return {
                        rule: id,
                        severity: level !== "warning" && options.escalate ? level : severity,
                        scope: "page",
                        url: page.url.href,
                        group: page.group,
                        ...said("{message}", { message: key.slice(key.indexOf(" ") + 1) }),
                        value: hits.map(({ line, column, selector }) => ({ line, column, selector })),
                        locations: [...new Set(hits.map(({ line, column, selector }) => (line === undefined ? selector : `${line}:${column} ${selector}`)))],
                    };
                })
                .toArray();
        },
    });
}

// How much each rule matters, inside its own level’s band.
const LEVELS: Record<string, { severity: Exclude<Severity, "off">; score: number }> = {
    "structured-data/rich-result/invalid": { severity: "warning", score: 5.6 },
    "structured-data/type/unknown": { severity: "error", score: 6.8 },
    "structured-data/property/unknown": { severity: "warning", score: 4.2 },
    "structured-data/type/missing": { severity: "error", score: 6.8 },
    "structured-data/context/missing": { severity: "error", score: 6.6 },
    "structured-data/context/invalid": { severity: "error", score: 6.6 },
};

// The extractor and rules this module adds to the `structured-data` plugin, with their preset entries.
export default {
    extractors: [{ id: ID, extract }],
    rules: {
        "structured-data/rich-result/invalid": issueRule(
            "structured-data/rich-result/invalid",
            {
                docs: "https://developers.google.com/search/docs/appearance/structured-data/search-gallery",
                title: "Structured data does not meet its rich result requirements",
                rationale: "Google shows a rich result only when the node meets the feature’s requirements: required properties present and of the right type, or the page is ineligible for the appearance.",
                fix: "Give the node every property the finding names, each with the type its rich result requires, and drop the type when the page does not really describe it.",
            },
            { escalate: true },
        ),
        "structured-data/type/unknown": issueRule("structured-data/type/unknown", {
            docs: "https://schema.org/docs/schemas.html",
            title: "Structured data names a type schema.org does not define",
            rationale: "A type outside the vocabulary leaves the node unreadable, so search engines drop the whole block and the page loses whatever the node described.",
            fix: "Check the type’s spelling against the schema.org type hierarchy and name the closest defined type.",
        }),
        "structured-data/property/unknown": issueRule("structured-data/property/unknown", {
            docs: "https://schema.org/docs/developers.html",
            title: "A structured data property is not defined for its type",
            rationale: "A property its type does not support carries nothing a consumer can read, so search engines drop the value and may distrust the rest of the node.",
            fix: "Rename the property to one its type supports, or move it onto the type it belongs to.",
        }),
        "structured-data/type/missing": issueRule("structured-data/type/missing", {
            docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
            title: "A JSON-LD block describes nothing",
            rationale: "A block without a type names no entity, so search engines skip it silently and whatever it carries is lost.",
            fix: "Add an `@type` naming what the block describes, and drop blocks that carry nothing.",
        }),
        "structured-data/context/missing": issueRule("structured-data/context/missing", {
            docs: "https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data",
            title: "A JSON-LD block declares no vocabulary",
            rationale: "Without an `@context` the block’s terms are undefined, so a reader cannot tell `name` is schema.org’s and skips the block.",
            fix: 'Add `"@context": "https://schema.org"` to the block, before its type.',
        }),
        "structured-data/context/invalid": issueRule("structured-data/context/invalid", {
            docs: "https://schema.org/docs/gs.html",
            title: "Embedded structured data names no schema.org type",
            rationale: "Search engines read embedded markup against schema.org only, so an `itemtype` or `typeof` pointing elsewhere leaves the item invisible to them.",
            fix: "Point the attribute at the schema.org type that matches, as `https://schema.org/Recipe`.",
        }),
    },
    levels: LEVELS,
};
