<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Dead links, on the site and off it

- A link that leads nowhere, to this site or to another one, is one finding listing every page that carries it.
- Links to other sites are checked once per run and remembered for a week, so a re-run sends them nothing.
- A site that only asks the checker to slow down is not reported as dead.
- Feeds a page advertises in its head are crawled and checked too, even when no link points to them.
- Internal links marked nofollow are found, links to paid or user content can be held to a rel policy the owner declares, and a profile the site claims as its own that does not link back, as Mastodon verification requires, is reported.
