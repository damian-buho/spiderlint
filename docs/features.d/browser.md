<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Client-rendered pages audited as visitors see them

- A page whose tags, links or content appear only after its scripts run is rendered in a real browser, so what gets linted is what search engines and visitors see.
- The browser starts only when an enabled rule needs it; a site with no such rule is crawled over plain HTTP at full speed.
- Console errors, load timings and every resource a page loads at runtime become facts that rules can check.
