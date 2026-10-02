<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Feeds checked the way readers see them

- RSS, Atom and JSON feeds are checked against their own specifications: required fields, dates readers can parse, identifiers that never repeat or change, so subscribers never see an old post as new.
- Item content is read as a reader renders it: unrendered Markdown or MDX, template placeholders, relative links and images, double escaping and markup readers strip are each named with the item they sit in.
- Every item is compared with the page it links: a link that fails or redirects, a title, date or language that disagrees, a canonical URL the feed bypasses.
- How the feed is served for polling is judged too: its type and encoding, conditional requests, caching, size, and an XSL style sheet Chrome no longer applies.
- Podcast feeds can be checked for what directories require, as an opt-in.
