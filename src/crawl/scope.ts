// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

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
