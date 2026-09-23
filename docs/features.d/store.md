<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Crawl once, lint many times

- A crawl can be kept on disk and linted again with changed rules or groups, with no network access.
- An interrupted crawl resumes where it stopped.
- Binary downloads are judged by their headers and never fetched in full, so a linked archive or video costs no bandwidth.
