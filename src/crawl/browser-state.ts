// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import type { Page } from "playwright";

// Each rendered page’s browser DevTools port, when an extractor asked for one.
const ports = new WeakMap<Page, number>();
const loaded = new WeakMap<Page, string>();

// The DevTools port of the browser rendering `page`; undefined unless an active extractor is `debugging`.
export function debuggingPort(page: Page): number | undefined {
    return ports.get(page);
}

// Records the DevTools port of the browser rendering `page`.
export function setDebuggingPort(page: Page, port: number): void {
    ports.set(page, port);
}

// The digest of every sub-resource body `page` loaded; undefined when one failed, was not read, or a frame navigated.
export function loadedDigest(page: Page): string | undefined {
    return loaded.get(page);
}

// Records the sub-resource body digest of `page`.
export function setLoadedDigest(page: Page, digest: string): void {
    loaded.set(page, digest);
}
