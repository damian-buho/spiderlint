<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Client-rendered pages audited as visitors see them

- A page whose tags, links or content appear only after its scripts run is rendered in a real browser, so what gets linted is what search engines and visitors see.
- Only the sections that need a browser are rendered; the rest of the site is crawled over plain HTTP at full speed in the same run, and a section that renders its tags client-side can be detected on its own.
- Console errors, load timings and every resource a page loads at runtime become facts that rules can check.
- Accessibility is checked in the rendered page against WCAG A and AA, so defects that scripts introduce are caught too.
