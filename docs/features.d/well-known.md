<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# The files a site publishes beside its pages

- A missing or expired `security.txt` is reported, so security researchers always have a way to reach you.
- A site with a password field must lead `/.well-known/change-password` somewhere, so password managers can send users straight to the right form.
- Every other known file (privacy signals, OpenID and OAuth metadata, app links, Fediverse node info, AI crawler terms) is checked only when present, so publishing one never goes unnoticed as broken.
- Files for AI agents (`llms.txt`, agent cards, MCP and skill indices) are checked in their own opt-in preset, including links in `llms.txt` that lead to broken pages and whether pages offer a Markdown version.
- A missing page served as HTML counts as absent, so a site that answers every URL does not flood the report.
