// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import { Parser } from "htmlparser2";
import type { Node } from "postcss";
import type { ValidationError } from "csstree-validator";
import type { Facts, ResourceFacts } from "../facts/types.ts";
import { log } from "../logger.ts";
import { pageRule, resourceRule } from "../rules/builtin.ts";
import type { Make, Rule } from "../rules/types.ts";
import { definePlugin } from "./types.ts";

const ID = "css";
const require = createRequire(import.meta.url);
// Messages one style sheet or page keeps.
const MESSAGES_MAX = 200;
// Characters of the offending source a message quotes.
const SOURCE_MAX = 80;
// The rule a declaration list is wrapped in, so it parses as a style sheet; a type selector no caniuse feature matches.
const WRAPPER = "a{";

// Settings under `org.spiderlint.css`.
export interface CssSettings {
    // A browserslist query; unset reads the `.browserslistrc` or `package.json` of the working directory.
    targets?: string;
}

const SETTINGS = { type: "object", additionalProperties: false, properties: { targets: { type: "string", minLength: 1 } } };

type Kind = "parse" | "property" | "value";

// One defect a browser answers by dropping a declaration, a rule or a block.
export interface CssMessage {
    kind: Kind;
    message: string;
    line: number;
    column: number;
    // The declaration or selector around it.
    source?: string;
    // The element holding inline CSS: `<style>` or `<div style>`.
    in?: string;
}

// A feature caniuse tracks, used outside `@supports`: where it first appears and how often.
export interface CssFeature {
    feature: string;
    line: number;
    column: number;
    count: number;
    in?: string;
}

export interface CssFacts {
    messages: CssMessage[];
    features: CssFeature[];
}

// Where a CSS text starts in the document holding it, 1-based.
interface Origin {
    line: number;
    column: number;
}

type Libraries = [typeof import("css-tree"), typeof import("csstree-validator"), typeof import("lightningcss"), typeof import("postcss"), typeof import("doiuse/lib/Detector.js")];

// The parsers once loading; absent until a run’s rules read `css`.
const loaded: { libraries?: Promise<Libraries> } = {};

const load = (): Promise<Libraries> => (loaded.libraries ??= Promise.all([import("css-tree"), import("csstree-validator"), import("lightningcss"), import("postcss"), import("doiuse/lib/Detector.js")]));

// Vendor-prefixed names and values, which a browser without the vendor ignores by design.
const VENDOR = /(?:^|[\s(,:])-(?:webkit|moz|ms|o|khtml|apple|epub|xv|wap)-/i;
// Hacks aimed at old Internet Explorer: `\9`, filters and expressions, `*prop` and `_prop`.
const HACK = /\\9|progid:|expression\(|^[*_]/i;
// `@page` and its margin boxes, whose descriptors and at-rules css-tree’s grammar lacks.
const PAGED = new Set(["page", ...["top", "bottom"].flatMap((edge) => [`${edge}-left-corner`, `${edge}-left`, `${edge}-center`, `${edge}-right`, `${edge}-right-corner`]), ...["left", "right"].flatMap((edge) => [`${edge}-top`, `${edge}-middle`, `${edge}-bottom`])]);
// `env()`, which css-tree matches inside math functions only, as it skips `var()` everywhere.
const SUBSTITUTED = /(?<![\w-])env\(/i;
// Legacy aliases judged by the property they alias, whose grammar css-tree keeps current.
const ALIASES: Record<string, string> = { "word-wrap": "overflow-wrap" };
// lightningcss warnings css-tree already reports, with vendor awareness: unknown at-rules and unclosed input.
const DEFERRED = new Set(["AtRuleInvalid", "EndOfInput"]);

// The declaration or selector text around `offset`, between the nearest `;`, `{` or `}` on each side.
function around(css: string, offset: number): string {
    const start = Math.max(...[";", "{", "}"].map((mark) => css.lastIndexOf(mark, offset - 1))) + 1;
    const ends = [";", "{", "}"].map((mark) => css.indexOf(mark, offset)).filter((index) => index >= 0);
    const text = css
        .slice(start, ends.length > 0 ? Math.min(...ends) : css.length)
        .trim()
        .replaceAll(/\s+/g, " ");
    return text.length > SOURCE_MAX ? `${text.slice(0, SOURCE_MAX)}…` : text;
}

// The offset of a 1-based line and column in `css`.
function offsetOf(css: string, line: number, column: number): number {
    let offset = 0;
    for (let at = 1; at < line; at++) offset = css.indexOf("\n", offset) + 1;
    return offset + column - 1;
}

// A position in a CSS text moved to the document holding it.
function shift(origin: Origin, line: number, column: number): Origin {
    return { line: origin.line + line - 1, column: line === 1 ? origin.column + column - 1 : column };
}

// Whether a grammar error is a vendor extension, a known hack, or a gap in css-tree’s grammar rather than a defect.
function isExempt(error: ValidationError, source: string): boolean {
    const name = error.property ?? error.descriptor ?? "";
    return name.startsWith("-") || HACK.test(name) || error.atrule?.startsWith("-") === true || PAGED.has(error.atrule?.toLowerCase() ?? "") || VENDOR.test(source) || HACK.test(source) || (error.name === "SyntaxMatchError" && SUBSTITUTED.test(source));
}

// What a browser drops for a css-tree error: an unknown name is a property, a value outside its grammar a value, the rest a rule or block.
function kindOf(error: ValidationError): Kind {
    if (error.name === "SyntaxMatchError") return "value";
    return /^Unknown (?:property|at-rule descriptor) /.test(error.message) ? "property" : "parse";
}

// Whether a node is `@supports` or sits inside it, which guards it from browsers lacking it.
function isGuarded(node: Node): boolean {
    for (let parent: Node["parent"] | Node = node; parent; parent = parent.parent) if (parent.type === "atrule" && (parent as unknown as { name: string }).name.toLowerCase() === "supports") return true;
    return false;
}

// Every caniuse feature doiuse can detect.
const FEATURE_IDS = (): string[] => Object.keys((require("caniuse-lite") as typeof import("caniuse-lite")).features);

// Grammar, parse and feature facts of one CSS text: a style sheet, or a declaration list when `isDeclarations`.
async function lint(css: string, origin: Origin, isDeclarations: boolean, element?: string): Promise<CssFacts> {
    const [csstree, { validate }, { transform }, { default: postcss }, { default: Detector }] = await load();
    const text = isDeclarations ? `${WRAPPER}${css}}` : css;
    const start = isDeclarations ? { line: origin.line, column: origin.column - WRAPPER.length } : origin;
    const messages: CssMessage[] = [];
    const add = (kind: Kind, message: string, line: number, column: number, offset: number) => {
        messages.push({ kind, message: message.split("\n", 1)[0] as string, ...shift(start, line, column), source: around(text, offset), ...(element && { in: element }) });
    };
    const ast = csstree.parse(text, { positions: true, parseAtrulePrelude: false, parseRulePrelude: false, parseValue: false, parseCustomProperty: false, onParseError: (error) => add("parse", error.message, error.line, error.column, error.offset) });
    csstree.walk(ast, { visit: "Declaration", enter: (node) => void (node.property = ALIASES[node.property.toLowerCase()] ?? node.property) });
    for (const error of validate(ast)) {
        const source = around(text, error.offset);
        const isNoise = isExempt(error, source);
        log.debug({ element, line: error.line, column: error.column, error: error.message, source, isNoise }, "css grammar error");
        if (!isNoise) add(kindOf(error), error.message, error.line, error.column, error.offset);
    }
    try {
        const { warnings } = transform({ filename: "style.css", code: Buffer.from(text), errorRecovery: true });
        for (const warning of warnings) {
            const offset = offsetOf(text, warning.loc.line, warning.loc.column);
            const source = around(text, offset);
            const isNoise = DEFERRED.has(warning.type) || VENDOR.test(source) || HACK.test(source);
            log.debug({ element, type: warning.type, line: warning.loc.line, column: warning.loc.column, source, isNoise }, "css parse warning");
            if (!isNoise) add("parse", warning.message, warning.loc.line, warning.loc.column, offset);
        }
    } catch (error) {
        const loc = (error as { loc?: { line: number; column: number } }).loc;
        log.debug({ element, loc, error: error instanceof Error ? error.message : String(error) }, "css did not parse");
        if (loc) add("parse", error instanceof Error ? error.message : String(error), loc.line, loc.column, offsetOf(text, loc.line, loc.column));
    }
    const unique = new Map(messages.map((message) => [`${message.line}:${message.column}`, message])).values().toArray();
    if (unique.length > MESSAGES_MAX) log.debug({ element, messages: unique.length, kept: MESSAGES_MAX }, "css messages cut");
    return { messages: unique.slice(0, MESSAGES_MAX), features: features(postcss, Detector, text, start, element) };
}

// Each caniuse feature `text` uses outside `@supports`, first where it appears; none when postcss cannot parse it.
function features(postcss: Libraries[3]["default"], Detector: Libraries[4]["default"], text: string, start: Origin, element?: string): CssFeature[] {
    const used = new Map<string, CssFeature>();
    try {
        new Detector(FEATURE_IDS()).process(postcss.parse(text), ({ feature, usage, ignore }) => {
            const at = usage.source?.start;
            if (!at || ignore.includes(feature) || isGuarded(usage)) return;
            const known = used.get(feature);
            if (known) known.count++;
            else used.set(feature, { feature, ...shift(start, at.line, at.column), count: 1, ...(element && { in: element }) });
        });
    } catch (error) {
        log.debug({ element, error: error instanceof Error ? error.message : String(error) }, "css features not detected");
    }
    return used.values().toArray();
}

// A style sheet’s facts.
async function extractSheet(url: string, _contentType: string, body: Uint8Array): Promise<CssFacts> {
    const facts = await lint(new TextDecoder().decode(body), { line: 1, column: 1 }, false);
    log.debug({ url, messages: facts.messages.length, features: facts.features.length }, "style sheet linted");
    return facts;
}

// Each CSS `<style>` block and `style` attribute of an HTML document, with where its text starts.
function inlineCss(body: string): { css: string; origin: Origin; isDeclarations: boolean; element: string }[] {
    const lines = [0, ...body.matchAll(/\n/g).map((match) => match.index + 1)];
    const at = (offset: number): Origin => {
        const line = lines.findLastIndex((start) => start <= offset);
        return { line: line + 1, column: offset - (lines[line] as number) + 1 };
    };
    const found: ReturnType<typeof inlineCss> = [];
    let styleStart: number | undefined;
    const parser = new Parser({
        onopentag(name, attributes) {
            const tag = body.slice(parser.startIndex, parser.endIndex + 1);
            const attribute = /\sstyle\s*=\s*["']?/i.exec(tag);
            if (attribute && attributes.style !== undefined) found.push({ css: attributes.style, origin: at(parser.startIndex + attribute.index + attribute[0].length), isDeclarations: true, element: `<${name} style>` });
            if (name === "style" && (attributes.type ?? "text/css").toLowerCase() === "text/css") styleStart = parser.endIndex + 1;
        },
        onclosetag(name) {
            if (name !== "style" || styleStart === undefined) return;
            found.push({ css: body.slice(styleStart, parser.startIndex), origin: at(styleStart), isDeclarations: false, element: "<style>" });
            styleStart = undefined;
        },
    });
    parser.end(body);
    return found;
}

// An HTML page’s inline CSS facts; none for a page without any, or cut at `max-body-size`.
async function extractInline(page: Facts, body: string): Promise<CssFacts | undefined> {
    if (!page.html || page.http.size.truncated) return undefined;
    const blocks = inlineCss(body);
    log.debug({ url: page.url.href, blocks: blocks.length }, "inline css found");
    if (blocks.length === 0) return undefined;
    const linted = await Promise.all(blocks.map((block) => lint(block.css, block.origin, block.isDeclarations, block.element)));
    return {
        messages: linted.flatMap((facts) => facts.messages).slice(0, MESSAGES_MAX),
        features: Map.groupBy(
            linted.flatMap((facts) => facts.features),
            (used) => used.feature,
        )
            .values()
            .map((uses) => ({ ...(uses[0] as CssFeature), count: uses.reduce((sum, used) => sum + used.count, 0) }))
            .toArray(),
    };
}

// `count` with the noun or verb form agreeing with it.
const agree = (count: number, one: string, many: string) => (count === 1 ? one : many);

// What each kind of message costs the page, its docs and its fix.
const KINDS: Record<Kind, { name: string; says: (count: number, where: string) => string; docs: string; fix: string }> = {
    parse: {
        name: "parse-error",
        says: (count, where) => `${count} syntax ${agree(count, "error", "errors")} in ${where}, so browsers drop the rule or block ${agree(count, "it sits", "they sit")} in`,
        docs: "https://www.w3.org/TR/css-syntax-3/#error-handling",
        fix: 'Close every block and string, and write selectors browsers accept, as in a::before { content: "" }.',
    },
    property: {
        name: "unknown-property",
        says: (count, where) => `${count} ${agree(count, "declaration", "declarations")} in ${where} ${agree(count, "names", "name")} a property browsers do not know, so they drop ${agree(count, "it", "them")}`,
        docs: "https://developer.mozilla.org/docs/Web/CSS/Reference",
        fix: "Correct the property name, as in color: red for colr: red, or remove the declaration.",
    },
    value: {
        name: "invalid-value",
        says: (count, where) => `${count} ${agree(count, "declaration", "declarations")} in ${where} ${agree(count, "carries", "carry")} a value outside the property’s grammar, so browsers drop ${agree(count, "it", "them")}`,
        docs: "https://developer.mozilla.org/docs/Web/CSS/CSS_values_and_units/Value_definition_syntax",
        fix: "Give the property a value its grammar accepts, as in margin: calc(-1 * var(--gap)) for margin: -var(--gap).",
    },
};

const cssOf = (resource: ResourceFacts) => resource[ID] as CssFacts | undefined;
const isLinted = (_page: Facts, resource: ResourceFacts) => cssOf(resource) !== undefined;

// One location line: where, in which element, what, and the source it quotes.
const located = (message: CssMessage) => [`${message.line}:${message.column}`, message.in, message.message, message.source && `— ${message.source}`].filter(Boolean).join(" ");

// A style sheet rule, keyed by its URL, and its inline twin per page, over the messages of one kind.
function kindRules(kind: Kind): Record<string, Make> {
    const { name, says, docs, fix } = KINDS[kind];
    const of = (facts: CssFacts | undefined) => facts?.messages.filter((message) => message.kind === kind) ?? [];
    const sheet = resourceRule(
        `css/${name}`,
        isLinted,
        (resource, pages) => {
            const hits = of(cssOf(resource));
            return hits.length === 0 ? undefined : { message: `${says(hits.length, "the style sheet")}; used by ${pages} pages`, locations: hits.map((hit) => located(hit)) };
        },
        [`resources.${ID}`],
        (resource) => of(cssOf(resource)),
        { docs, fix },
    );
    const inline = pageRule(
        `css/inline-${name}`,
        [`${ID}.messages`],
        (page) => {
            const facts = page[ID] as CssFacts | undefined;
            const hits = of(facts);
            return facts && (hits.length === 0 ? [] : [{ message: says(hits.length, "inline CSS"), value: hits, locations: hits.map((hit) => located(hit)) }]);
        },
        { docs, fix },
    );
    return { [`css/${name}`]: sheet, [`css/inline-${name}`]: inline };
}

// The browsers a run judges support against, and the query naming them.
interface Targets {
    query: string;
    browsers: string[];
}

// Targets per query, a bad one remembered as none, so each warns once.
const targetsByQuery = new Map<string, Targets | undefined>();

// The declared browser targets: the `targets` setting, else the working directory’s browserslist config; none warns once.
function targetsOf(settings: CssSettings): Targets | undefined {
    const browserslist = require("browserslist") as typeof import("browserslist");
    const query = settings.targets ?? browserslist.loadConfig({ path: process.cwd() })?.join(", ") ?? "";
    if (!targetsByQuery.has(query)) {
        try {
            targetsByQuery.set(query, query === "" ? undefined : { query, browsers: browserslist(query) });
        } catch (error) {
            targetsByQuery.set(query, undefined);
            log.warn({ query, error: error instanceof Error ? error.message : String(error) }, `css/unsupported skipped, the browser targets "${query}" do not parse:`);
        }
        if (query === "") log.warn({ cwd: process.cwd() }, "css/unsupported skipped: no browser targets, set org.spiderlint.css.targets or add a .browserslistrc");
    }
    return targetsByQuery.get(query);
}

// caniuse data per feature, unpacked once.
const unpacked = new Map<string, ReturnType<typeof import("caniuse-lite").feature> | undefined>();

// Each browser among `browsers` caniuse marks as lacking `feature`, named with its lowest and highest such version; partial support counts as support.
function lacking(feature: string, browsers: string[]): string[] {
    const caniuse = require("caniuse-lite") as typeof import("caniuse-lite");
    if (!unpacked.has(feature)) unpacked.set(feature, caniuse.features[feature] && caniuse.feature(caniuse.features[feature]));
    const stats = unpacked.get(feature)?.stats ?? {};
    const lacks = browsers.map((browser) => browser.split(" ") as [string, string]).filter(([name, version]) => /^[np]\b/.test(stats[name]?.[version] ?? "y"));
    return Map.groupBy(lacks, ([name]) => name)
        .entries()
        .map(([name, entries]) => {
            const versions = entries.map(([, version]) => version).toSorted((a, b) => a.localeCompare(b, "en", { numeric: true }));
            const [first, last] = [versions[0], versions.at(-1)];
            return `${caniuse.agents[name]?.browser ?? name} ${first}${first === last ? "" : `–${last}`}`;
        })
        .toArray();
}

// The features of `facts` the targets lack, as a message and one location each.
function unsupportedIn(facts: CssFacts, targets: Targets): { message: string; locations: string[] } | undefined {
    const lacks = facts.features.map((used) => ({ used, browsers: lacking(used.feature, targets.browsers) })).filter(({ browsers }) => browsers.length > 0);
    log.debug({ query: targets.query, features: facts.features.length, lacked: lacks.length }, "css features judged");
    const locations = lacks.map(({ used, browsers }) => [`${used.line}:${used.column}`, used.in, unpacked.get(used.feature)?.title ?? used.feature, `— ${browsers.join(", ")}`].filter(Boolean).join(" "));
    return lacks.length === 0 ? undefined : { message: `uses ${lacks.length} ${agree(lacks.length, "feature", "features")} the browser targets “${targets.query}” lack`, locations };
}

const UNSUPPORTED = { docs: "https://developer.mozilla.org/docs/Web/CSS/@supports", fix: "Give the feature a fallback declaration before it, or guard it with @supports (display: grid) { … }." };

// A rule that runs only once browser targets are declared.
function targeted(rule: Rule, settings: CssSettings): Rule {
    return { meta: rule.meta, check: (...parameters: Parameters<Rule["check"]>) => (targetsOf(settings) ? (rule.check as (...all: Parameters<Rule["check"]>) => ReturnType<Rule["check"]>)(...parameters) : undefined) } as Rule;
}

// Style sheets using features the declared browser targets lack, keyed by URL.
const unsupported: Make = (severity, settings) =>
    targeted(
        resourceRule(
            "css/unsupported",
            isLinted,
            (resource, pages) => {
                const judged = unsupportedIn(cssOf(resource) as CssFacts, targetsOf(settings as CssSettings) as Targets);
                return judged && { message: `style sheet ${judged.message}; used by ${pages} pages`, locations: judged.locations };
            },
            [`resources.${ID}`],
            (resource) => cssOf(resource)?.features,
            UNSUPPORTED,
        )(severity),
        settings as CssSettings,
    );

// Inline CSS using features the declared browser targets lack, per page.
const inlineUnsupported: Make = (severity, settings) =>
    targeted(
        pageRule(
            "css/inline-unsupported",
            [`${ID}.features`],
            (page) => {
                const facts = page[ID] as CssFacts | undefined;
                const judged = facts && unsupportedIn(facts, targetsOf(settings as CssSettings) as Targets);
                return facts && (judged ? [{ message: `inline CSS ${judged.message}`, value: facts.features.length, locations: judged.locations }] : []);
            },
            UNSUPPORTED,
        )(severity),
        settings as CssSettings,
    );

export default definePlugin({
    name: "css",
    settings: SETTINGS,
    extractors: [{ id: ID, extract: extractInline }],
    resources: [{ id: ID, types: ["text/css"], extract: extractSheet }],
    rules: { ...kindRules("parse"), ...kindRules("property"), ...kindRules("value"), "css/unsupported": unsupported, "css/inline-unsupported": inlineUnsupported },
    presets: {
        css: {
            description: "Style sheets and inline CSS as browsers parse them: syntax errors, unknown properties, values outside the grammar, and features the declared browser targets lack",
            rules: {
                "css/parse-error": { severity: "warning", score: 5.6 },
                "css/unknown-property": { severity: "warning", score: 4.6 },
                "css/invalid-value": { severity: "warning", score: 4.4 },
                "css/unsupported": { severity: "info", score: 2.2 },
                "css/inline-parse-error": { severity: "warning", score: 5.2 },
                "css/inline-unknown-property": { severity: "warning", score: 4.2 },
                "css/inline-invalid-value": { severity: "warning", score: 4 },
                "css/inline-unsupported": { severity: "info", score: 1.8 },
            },
        },
    },
});
