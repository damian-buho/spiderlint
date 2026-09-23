<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# One finding per template, not per page

- Pages are grouped by URL pattern, so a defect every post shares is reported once for the post template, with sample pages.
- A group whose pages disagree on a rule gets an advisory that it likely mixes two templates.
- Values that must be unique across the site, such as titles and descriptions, are reported once per duplicate with every URL that shares it.
- Results come as text, JSON or SARIF, so code-scanning views show one row per defect.
