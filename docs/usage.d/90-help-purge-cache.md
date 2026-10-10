<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint purge-cache

```console
$ spiderlint purge-cache --help
Usage: spiderlint purge-cache [options] [bucket] [domain…]
Delete a site’s cached entries.

A bucket is one of pages, probes, profiles, resources, robots, sitemaps,
origins, dns, extractors; with none, every bucket is purged.
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.

Purge:
  --older-than <age>  only entries older than 45s, 30m, 24h or 7d

Store:
  --store <dir>       store directory (default: /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Drop cached pages older than a week:
    spiderlint purge-cache pages example.com --older-than 7d
```
