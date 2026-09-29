<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# The DNS behind every crawled host

- Missing HTTPS records are reported, so a first visit can start on HTTP/3 without a round trip to discover it.
- CAA is judged against the certificate the site actually serves, so a CA that CAA forbids is caught before it fails a renewal.
- DNSSEC is checked end-to-end: an unsigned zone, weak algorithms, stalled re-signing, and a signed zone that validating resolvers reject.
- Name servers are asked directly and every other query goes only to the resolver you name, so a lame server or a zone out of sync shows, and a link to a subdomain whose CNAME points nowhere is flagged as a takeover risk.
- Each name is judged by what its records say it does with mail: one that takes none is held to a null MX, a deny-all SPF and a DMARC reject policy, one that does to a single closed SPF record and an enforced DMARC policy, so a half-finished setup shows either way.
- The domain registration is read from its registry, so a renewal that is days away, a missing transfer lock or a registry naming other name servers than the zone shows before the domain lapses or is taken.
- Every address is traced to the network that routes it, so a route that RPKI-enforcing networks drop, a mail server with no matching reverse DNS, or a site and its name servers all behind one provider come to light.
