<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Feeds, structured data and markup checked on every page

- RSS, Atom and JSON feeds are checked for what feed readers rely on: they parse, name their own URL, and give every item an identifier that never changes, so subscribers never see an old post as new.
- Structured data in JSON-LD, Microdata or RDFa is reported when it does not parse, lacks what its rich result needs, contradicts the page or the rest of the site, uses retired schema.org terms or malformed or contradictory dates, or has breadcrumbs leading to missing or moved pages.
- The web app manifest is checked for what installing the site needs: a name, a start page, a display mode and icons in the sizes phones ask for.
- Vague link text such as “click here” is found in the page’s own language, and a language without a reviewed list is skipped rather than judged in English.
- The analytics and advertising vendors a site loads are listed in one inventory, so what the privacy policy must name is known.
