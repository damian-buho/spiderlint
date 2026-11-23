// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// The slices of @adobe/structured-data-validator 1.7 and @marbec/web-auto-extractor 2.2 spiderlint calls; neither package ships types.
declare module "@adobe/structured-data-validator" {
    export interface ValidationPath {
        type?: string;
        property?: string;
        index?: number;
        length?: number;
    }

    // One issue the validator reports, over the Web Auto Extractor’s parse.
    export interface ValidationIssue {
        issueMessage: string;
        severity: "ERROR" | "WARNING";
        path: ValidationPath[];
        fieldNames: string[];
        // The top-level type the issue sits under, and the syntax it was read from.
        rootType: string;
        dataFormat: string;
        // `schemaOrg` marks the vocabulary checks every typed node passes.
        errorType?: string;
        // The root item’s character span in the page, `start,end`.
        location?: string;
        source?: string;
    }

    export default class Validator {
        constructor(schemaOrgJson?: unknown);
        validate(waeData: { jsonld?: unknown; microdata?: unknown; rdfa?: unknown }): Promise<ValidationIssue[]>;
    }
}

declare module "@marbec/web-auto-extractor" {
    export interface ExtractionError {
        message: string;
        format: string;
        source?: string;
        sourceCodeLocation?: { startOffset: number; endOffset: number };
    }

    export default class WebAutoExtractor {
        constructor(options?: { addLocation?: boolean; embedSource?: boolean | string[] });
        parse(html: string): { jsonld: Record<string, object[]>; microdata: Record<string, object[]>; rdfa: Record<string, object[]>; errors: ExtractionError[] };
    }
}
