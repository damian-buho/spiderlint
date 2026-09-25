<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Image weight measured, not estimated

- Every image the site loads is re-encoded once, and the bytes AVIF, WebP or a tighter encode of its own format would save are reported.
- Each heavy image is one finding with the pages that use it, across the whole site rather than a sample of pages.
- Images that ship far more pixels than they display, or have no width and height to hold their place, are flagged per template.
- Measurements are cached with the image, so a re-run measures only what changed.
