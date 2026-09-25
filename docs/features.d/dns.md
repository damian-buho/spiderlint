<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# The DNS behind every crawled host

- Missing HTTPS records are reported, so a first visit can start on HTTP/3 without a round trip to discover it.
- CAA is judged against the certificate the site actually serves, so a CA that CAA forbids is caught before it fails a renewal.
- DNSSEC is checked end-to-end: an unsigned zone, weak algorithms, stalled re-signing, and a signed zone that validating resolvers reject.
- Name servers are asked directly, so a lame server or a zone out of sync shows, and a link to a subdomain whose CNAME points nowhere is flagged as a takeover risk.
- Queries go only to the resolver you name, and are reused for as long as the records say.
