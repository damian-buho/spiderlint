<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# TLS configuration scanned in-house

- Every protocol and cipher suite a server accepts is listed, SSLv2, SSLv3, RC4 and export suites included, which today’s TLS libraries can no longer see.
- Broken and weak suites, missing forward secrecy, short Diffie-Hellman primes and record compression are findings, and so are the attacks they open: POODLE, BEAST, SWEET32, FREAK, Logjam, DROWN and CRIME.
- A certificate chain missing its intermediates is caught on TLS 1.3-only servers too.
- A house rule such as “no CBC suites” is a few lines of configuration, not code.
- No outside scanner is asked and nothing is exploited: the server is only asked what it will negotiate, once per origin while the result stays fresh.
