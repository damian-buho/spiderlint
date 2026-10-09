<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Feeds checked the way readers see them

- RSS, Atom and JSON feeds are checked against their own specifications: required fields, dates readers can parse, identifiers that never repeat or change, so subscribers never see an old post as new.
- Item content is read as a reader renders it: unrendered Markdown or MDX, template placeholders, relative links and images, double escaping and markup readers strip are each named with the item they sit in.
- Every item is compared with the page it links: a link that fails or redirects, a title, date or language that disagrees, a canonical URL the feed bypasses, and a feed of teasers where readers expect posts.
- How the feed is served for polling is judged too: its type and encoding, conditional requests down to a revalidation answered 200 with an unchanged body instead of 304, caching, size, and an XSL style sheet Chrome no longer applies.
- Podcast feeds can be checked for what directories require, as an opt-in: the iTunes channel and episode tags, a stable Podcasting 2.0 GUID, a `podcast:locked` policy, and artwork Apple accepts — square JPEG or PNG, 1400–3000 px per side.
- Every enclosure is answered once with HEAD and judged against its declaration: reachability, byte and type agreement, and byte-range support, which Apple requires of episode hosts.
- A declared WebSub hub can be probed with a discovery request, opt-in only.
- A sample of the W3C feed validator corpus ships as fixtures, so every message it fires keeps firing one here.
- A podcast directory requires RSS 2.0 with the iTunes and content namespaces declared, a unique enclosure with URL, length and type per episode, a GUID per episode that never changes, and RFC 2822 dates.
