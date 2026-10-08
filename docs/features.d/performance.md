<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Speed problems found without a browser

- Every text response must be compressed with Brotli, Zstandard or gzip, and every page must be cacheable, revalidatable and eligible for the back/forward cache.
- A server still on HTTP/1.1, one that does not advertise HTTP/3, and a certificate whose RSA key makes every handshake larger than an EC key would are reported.
- A file a browser or CDN may keep for a long time at a URL that never changes, so it stays stale after the next publish, is reported by file type.
- Scripts and style sheets that block the first render, a lazy loaded first image, and images with no size to hold their place are found in the HTML of every page.
- Rendered pages get Lighthouse performance, accessibility, best-practices and SEO scores and lab LCP, CLS, TBT and FCP, on a sample of each template.
