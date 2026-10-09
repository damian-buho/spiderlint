// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { getDomain } from "tldts";

export type Scope = "origin" | "host" | "domain";

// Crawlee enqueue strategy carrying the same meaning as each scope.
export const STRATEGY: Record<Scope, "same-origin" | "same-hostname" | "same-domain"> = {
    origin: "same-origin",
    host: "same-hostname",
    domain: "same-domain",
};

// Same-domain compares registrable domains, as Crawlee's strategy does.
export function isInScope(link: URL, page: URL, scope: Scope): boolean {
    if (scope === "origin") return link.origin === page.origin;
    return scope === "host" ? link.hostname === page.hostname : (getDomain(link.hostname, { mixedInputs: false }) ?? link.hostname) === (getDomain(page.hostname, { mixedInputs: false }) ?? page.hostname);
}

// The one origin every URL shares, or empty when they span several.
export function singleOrigin(urls: Iterable<string>): string {
    const origins = new Set([...urls].flatMap((href) => (URL.canParse(href) ? [new URL(href).origin] : [])));
    return origins.size === 1 ? ([...origins][0] as string) : "";
}

// `href` under `from` moved onto `to`, path and query kept; any other URL passes through.
export function onOrigin(href: string, from: string | undefined, to: string): string {
    if (!from || from === to || !URL.canParse(href)) return href;
    const url = new URL(href);
    return url.origin === from ? new URL(`${url.pathname}${url.search}${url.hash}`, to).href : href;
}

// A URL under `origin` becomes its path; any other passes through.
export function relative(href: string, origin: string): string {
    return origin && href.startsWith(`${origin}/`) ? href.slice(origin.length) : href;
}
