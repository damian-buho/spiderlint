<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Each origin checked once, beyond its pages

- A missing page is requested on purpose, so a soft 404, or an error page that leaks a stack trace or a server version, is a finding.
- Every way in — http or https, with or without `www.`, at the root or deep in the site — must land on one canonical origin in a permanent redirect that keeps the path, and the home page must not redirect visitors by their language.
- Cross-domain policy files that let any other site read pages with the visitor’s session are reported.
- Plugins add their own once-per-origin or once-per-host checks; their results are reused between runs, and their requests never leave the host they check.
