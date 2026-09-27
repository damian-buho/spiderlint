<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Scan server

- The same image runs as an HTTP API with a job queue, so a team or the public can request audits without installing anything.
- Each scan reports its progress while it runs, and its report downloads in every format the command line writes.
- The instance owner sets policies per domain: ban a top-level domain, limit how often a host may be scanned, cap pages and time, and choose which rules may run.
- Policies reload from a mounted file without a restart.
- A scan cannot be aimed at loopback, private or cloud metadata addresses.
