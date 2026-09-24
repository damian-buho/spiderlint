// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import type { Facts } from "../facts/types.ts";
import type { Make, RulesetConfig } from "../rules/types.ts";

// Facts from one fetched page and its body, stored under `id`; undefined adds nothing.
export interface Extractor {
    id: string;
    extract(page: Facts, body: string): Promise<unknown>;
}

// A plugin module’s default export.
export interface Plugin {
    name: string;
    extractors?: Extractor[];
    rules?: Record<string, Make>;
    presets?: Record<string, RulesetConfig>;
}

// Types a plugin’s default export.
export function definePlugin(plugin: Plugin): Plugin {
    return plugin;
}
