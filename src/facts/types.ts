// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

export interface HttpFacts {
    status: number;
    headers: Record<string, string | string[]>;
    size: { body: number };
}

export interface HtmlFacts {
    lang?: string;
    title?: string;
    h1: string[];
    canonical?: string;
    meta: Record<string, string>;
}

export interface Facts {
    url: { href: string; origin: string; pathname: string };
    group: string;
    http: HttpFacts;
    html?: HtmlFacts;
}
