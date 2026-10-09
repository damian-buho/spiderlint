<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint show-report

```console
$ spiderlint show-report --help
Usage: spiderlint show-report [options] [domain…]
Print the stored report again, in any format.

A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.

Report:
  --format <format>  human, json, sarif, checkstyle, csv, html, agent, …
                     (default: human, env: SPIDERLINT_FORMAT)
  --fail-on <level>  exit 1 at error, warning, info, 0.1–9.9 or never
                     (default: error, env: SPIDERLINT_FAIL_ON)
  --unfold           one finding per page, every URL and location listed
                     (env: SPIDERLINT_FOLD=false)
  --show-hints       list hints in human output, not only their count
  --explain          print each finding’s fix and docs in human output
  --stats            count, min, median, p95, max, total per numeric fact
  --output <dir>     with --format agent, one prompt file per rule in dir

Store:
  --store <dir>      store directory (default: /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Turn the last report into a web page:
    spiderlint show-report example.com --format html > report.html
```
