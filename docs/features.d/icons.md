<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Icons fetched and measured

- Every icon the pages, the web app manifest and `browserconfig.xml` name is downloaded once and measured, so an icon that is really smaller than it claims, or another format, is a finding.
- The favicon, the Apple touch icon, the SVG icon, the Safari pinned tab and the Windows tiles are each judged on what the platform really asks for, such as an opaque 180×180 PNG for iOS.
- A page that links no Apple touch icon is checked against the path iOS requests anyway.
