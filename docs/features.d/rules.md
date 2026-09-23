<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Rules as data, with presets

- A rule is a fact path plus a JSON Schema, so a new check needs no code.
- Bundled presets cover SEO, security headers, TLS, cookies, redirects, sitemaps, links and page resources.
- Each URL group runs its own rule sets, and any rule’s severity can be changed or switched off from the command line, the environment or the projectfile.
