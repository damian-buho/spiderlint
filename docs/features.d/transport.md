<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Transport checked per page, not per host

- Certificate, TLS protocol and remote address are read from the connection that served each page, so two backends behind one name are reported instead of hidden.
- Certificates close to expiry, rejected certificates and outdated TLS versions are findings.
- Timings, redirect chains and cookie flags are recorded for every page, and cookie values never leave the crawler.
- A `__Host-` cookie browsers would silently reject, and a preload an early hint promises that the page then drops, are reported.
