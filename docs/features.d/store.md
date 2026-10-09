<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Crawl once, lint many times

- A crawl can be kept on disk and linted again with changed rules or groups, with no network access.
- An interrupted crawl resumes where it stopped.
- A repeat crawl asks the site only whether each page, script and sitemap changed, and neither downloads nor analyses again what did not.
- Binary downloads are judged by their headers and never fetched in full, so a linked archive or video costs no bandwidth.
- A staging copy is audited as the site it is built for, so its links and sitemap naming the production address are not reported as wrong.
