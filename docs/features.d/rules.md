<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Over 500 rules, and new ones written as data

- A rule is a fact path plus a JSON Schema, so a new check needs no code.
- Bundled presets cover search, security headers, TLS, DNS, cookies, performance, accessibility, privacy, sustainability, links, redirects, sitemaps, robots.txt, well-known files and files for AI agents.
- Each URL group runs its own rule sets, and any rule’s severity can be changed or switched off from the command line, the environment or the projectfile.
- axe-core, html-validate and htmlhint run inside the same crawl, each of their checks a rule you can tune or switch off like any other, and Lighthouse scores join them on rendered pages.
- Plugins add their own facts, rules, presets, report formats and URL sources beside the bundled ones, and a plain list of URLs can be audited on its own.
