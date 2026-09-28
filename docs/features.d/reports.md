<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Reports for people, pipelines and coding agents

- Findings come as text, JSON, SARIF, Checkstyle, CSV or an HTML report, and a stored crawl is re-formatted without fetching the site again.
- Each finding can say how to fix it for the site at hand, the exact record, header or tag with the site’s own names filled in, and code scanning shows the same guidance beside every alert.
- The agent format turns findings into fix prompts for a coding agent, ordered by severity and by how many pages each fix clears.
- A CI action audits a site on every push, fails the job at the severity you choose, uploads SARIF to code scanning, and caches the crawl so an unchanged site costs almost nothing to re-audit.
- Exit codes tell findings apart from a bad configuration and from a site that could not be reached, so a pipeline knows which one failed.
