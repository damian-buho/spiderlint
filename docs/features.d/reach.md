<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Sites on any network, crawled politely

- Onion services and I2P sites are audited with one setting, through the local Tor or I2P proxy, at the pace and timeouts those networks need.
- Every request of the plain and the browser crawl can go through an HTTP, HTTPS or SOCKS proxy, including SOCKS proxies that resolve hostnames themselves.
- A server that answers “too many requests” or “unavailable” is retried with backoff and its `Retry-After` honoured, and a cap on requests per minute keeps the crawl within what a site tolerates.
- robots.txt is obeyed unless you say otherwise.
