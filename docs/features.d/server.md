<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Scan server

- The same image runs as an HTTP API with a job queue and a web page where anyone types a domain and reads the report in English, Spanish or Ukrainian, with or without JavaScript.
- Each scan reports its progress while it runs, its report downloads in every format the command line writes, and a site can show its latest grade as a badge linking to the report.
- The instance owner sets policies per domain: ban a top-level domain, limit how often a host may be scanned, cap pages and time, and choose which rules may run. A repeat request inside a set window returns the scan already made, and each client has its own limit.
- Policies reload from a mounted file without a restart.
- A scan cannot be aimed at loopback, private or cloud metadata addresses.
