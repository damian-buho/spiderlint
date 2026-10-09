<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# What the CDN or host adds, kept apart

- Pages a CDN or host serves on the site, such as Cloudflare’s email protection page, are not judged as the site’s own, so they cannot lower its grade.
- Scripts the CDN or host injects are still checked, and their findings are listed under the vendor that serves them.
- A feature switched on in the CDN dashboard that costs visitors something, such as email addresses hidden from anyone without JavaScript, is named with the setting that turns it off.
