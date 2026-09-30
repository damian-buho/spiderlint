<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# spiderlint export-facts

```console
$ spiderlint export-facts --help
Usage: spiderlint export-facts [options] [domain…]
Print every stored page’s facts, no network.

Facts are what spiderlint records about a page, such as headers, HTML, TLS,
timings and sizes; rules judge them.
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.

Output:
  --format <format>  human, json, yaml, csv (default: human)
  --facts <glob>     fact paths to show, repeatable

Store:
  --store <dir>      store directory (default: /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Export page weight and timings as CSV:
    spiderlint export-facts example.com --format csv --facts 'co2.*' --facts 'http.timing.*'
```
