// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

// The slices of csstree-validator 4.0 and doiuse 6.0 spiderlint calls; neither package ships types.
declare module "csstree-validator" {
    import type { CssNode } from "css-tree";
    export interface ValidationError {
        name: string;
        message: string;
        line: number;
        column: number;
        offset: number;
        property?: string;
        atrule?: string;
        descriptor?: string;
    }
    export function validate(ast: CssNode): ValidationError[];
}

declare module "doiuse/lib/Detector.js" {
    import type { Node, Root } from "postcss";
    export default class Detector {
        constructor(features: string[]);
        process(root: Root, callback: (usage: { feature: string; usage: Node; ignore: string[] }) => void): void;
    }
}
