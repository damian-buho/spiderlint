// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { label, withUnit, type NumberFormat } from "../facts/labels.ts";
import { utc } from "../facts/read-note.ts";
import { translator, type Translator } from "../i18n.ts";
import type { Datum, Evidence, Finding } from "./types.ts";

const english = translator("en");

// Numbers as English writes them, one decimal.
export const inEnglish: NumberFormat = (value, options) => english.number(value, options);

// A datum as text, numbers in `format`, a fact’s label through `translate`.
export function written(datum: Datum, format: NumberFormat, translate = (text: string) => text): string {
    if (typeof datum === "string") return datum;
    if (typeof datum === "number") return format(datum);
    if ("fact" in datum) return withUnit(datum.fact, datum.value, format);
    if ("name" in datum) return translate(label(datum.name) ?? datum.name);
    return "ratio" in datum ? `${format(datum.ratio)}×` : utc(datum.at);
}

// Every datum of a record as text, numbers in `format`, labels through `translate`.
export function writtenAll(data: Record<string, Datum> = {}, format: NumberFormat, translate?: (text: string) => string): Record<string, string> {
    return Object.fromEntries(Object.entries(data).map(([key, datum]) => [key, written(datum, format, translate)]));
}

// A finding’s sentence in `t`’s language and locale; a finding with no template keeps its English message.
export function sentence(finding: Pick<Finding, "message" | "text" | "variables">, t: Translator = english): string {
    return finding.text === undefined
        ? finding.message
        : t._(
              finding.text,
              writtenAll(finding.variables, t.number, (text) => t._(text)),
          );
}

// The message fields of a finding from its template and shared values.
export function said(text: string, variables?: Record<string, Datum>): Pick<Finding, "message" | "text" | "variables"> {
    return { message: sentence({ message: "", text, variables }), text, ...(variables && { variables }) };
}

// The values measured at `url`, as text in `format`, in the order the rule wrote them.
export function valuesAt(finding: Pick<Finding, "data">, url: string, format: NumberFormat): string[] {
    return Object.values(writtenAll(finding.data?.[url], format));
}

// Observations the findings rest on that this run took from a cache rather than the origin, once each.
export function cachedReads(findings: Pick<Finding, "evidence">[]): Evidence[] {
    return new Map(
        findings
            .flatMap((finding) => finding.evidence ?? [])
            .filter((read) => read.via === "cache")
            .map((read) => [`${read.bucket}:${read.key}`, read]),
    )
        .values()
        .toArray();
}
