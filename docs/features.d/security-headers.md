<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Security headers judged, not just detected

- Content-Security-Policy is read directive by directive, from the header or a `<meta>`: inline scripts without a nonce or hash, `eval`, scripts from any host, and a missing `object-src`, `base-uri`, `frame-ancestors` or Trusted Types are each a finding of their own.
- HSTS must last long enough and cover subdomains, and responses must not be sniffed, framed by other sites, or leak full URLs through the referrer.
- Cross-origin isolation, Permissions-Policy and reporting endpoints are checked on every page, not only the front page.
- An X-XSS-Protection header that still turns the retired filter on is reported, since that filter can itself be abused.
- A header that breaks its own grammar, such as an HSTS max-age that is not a number or a Cache-Control directive no cache knows, is one finding naming the fault, instead of passing because it is present or failing every check that reads it.
