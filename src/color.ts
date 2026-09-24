// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { styleText } from "node:util";

export type Style = Parameters<typeof styleText>[0];
export type Paint = (style: Style, text: string) => string;

// Leaves text untouched; the default for formatters called outside a terminal.
export const plain: Paint = (_style, text) => text;

// --color forces, --no-color disables, unset lets node read the TTY, NO_COLOR and FORCE_COLOR.
export function painter(stream: NodeJS.WritableStream, hasColor?: boolean): Paint {
    return hasColor === false ? plain : (style, text) => styleText(style, text, hasColor ? { validateStream: false } : { stream });
}
