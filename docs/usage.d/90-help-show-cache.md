<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint show-cache

```console
$ spiderlint show-cache --help
Usage: spiderlint show-cache [options] [domain…]
Show the entries, bytes and age of each bucket.

A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.

Store:
  --store <dir>  store directory (default: /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  See what is cached for a site:
    spiderlint show-cache example.com
```
