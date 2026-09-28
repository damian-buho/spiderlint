<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Accessibility checked from every side

- Every axe-core rule for WCAG 2.2 A and AA, and its best practices, runs in the rendered page, so defects that scripts introduce are caught too.
- The markup of every page, not a sample, is checked for the accessibility defects html-validate sees without a browser: missing labels, skipped heading levels, missing alt text.
- Keyboard use is tried on a few pages per template: Tab must reach every control without a trap, focus must show and stay uncovered, a skip link must come first, and click handlers on plain elements are reported.
- Visitor settings are honoured: animations stop under reduced motion, text stays readable in the dark scheme and the higher contrast a page offers, focus and icons survive Windows high contrast, and form fields are large enough that phones do not zoom.
