<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Mail authentication of every domain it crawls

- A domain that takes or sends mail is found on its own, and one that does neither keeps the no-mail checks, so nobody has to say which kind it is.
- SPF is walked through every include the way receivers walk it, so a record that silently fails on too many lookups or a missing include shows before mail bounces.
- DMARC, DKIM and MX are checked for the faults receivers punish: several policies, report addresses that refuse the reports, short keys, keys left in testing, and mail servers behind a CNAME.
- MTA-STS, TLS reporting and BIMI are read end-to-end, so a policy that leaves a mail server out or a logo no mail client will show is caught.
- DANE and a live STARTTLS check of each mail server are there when you turn them on.
