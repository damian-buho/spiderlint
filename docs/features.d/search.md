<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Search visibility checked across the whole site

- Titles, descriptions, headings, canonical links and Open Graph tags are checked on every page, and a title or description that pages share is one finding listing all of them.
- The sitemap is held against the crawl: pages it lists that no page links to, pages it leaves out, and listed pages marked noindex are reported.
- Pages more than three clicks from the start page, pages that link nowhere, and pages only one other page links to are found in the link graph of the whole site.
- Language versions must name each other back and answer, and each page’s declared language is compared with the language its title and description are written in.
- A staging or development copy left open to indexing is caught before search engines find it.
