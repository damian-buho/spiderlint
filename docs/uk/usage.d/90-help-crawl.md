<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint crawl

```console
$ spiderlint crawl --help
Usage: spiderlint crawl [options] [domain…]
Fetch pages into the store, lint nothing.

A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.

Crawl:
  --fetch <mode>            auto, http, browser or adaptive
                            (default: auto, env: SPIDERLINT_FETCH)
  --browser <name>          chromium, firefox or webkit
                            (default: chromium, env: SPIDERLINT_BROWSER)
  --scope <scope>           follow links within the origin, host or domain
                            (default: origin, env: SPIDERLINT_SCOPE)
  --concurrency <n>         pages in flight, 0: one per CPU, halved in a browser
                            (default: 0, env: SPIDERLINT_CONCURRENCY)
  --rate <n>                requests per minute, 0 for no limit
                            (default: 0, env: SPIDERLINT_RATE)
  --timeout <seconds>       seconds one page may take
                            (default: 60, env: SPIDERLINT_TIMEOUT)
  --profile <name>          tor or i2p: local proxy, concurrency 4, timeout 240
                            (env: SPIDERLINT_PROFILE)
  --proxy <url>             http, https or socks5h proxy for every request
                            (env: SPIDERLINT_PROXY)
  --via <host>              instance a web scan names in its user agent
                            (env: SPIDERLINT_VIA)
  --max-pages <n>           page limit, 0 for none
                            (default: 0, env: SPIDERLINT_MAX_PAGES)
  --max-depth <n>           link depth limit, 0 for none
                            (default: 0, env: SPIDERLINT_MAX_DEPTH)
  --max-body-size <bytes>   body size cap
                            (default: 10000000, env: SPIDERLINT_MAX_BODY_SIZE)
  --include-urls <glob>     crawl only matching paths and queries, repeatable
                            (env: SPIDERLINT_INCLUDE_URLS)
  --exclude-urls <glob>     skip matching paths and queries, repeatable
                            (env: SPIDERLINT_EXCLUDE_URLS)
  --source <id:arg>         add a plugin source’s URLs; list:FILE crawls a URL
                            list only, repeatable
                            (env: SPIDERLINT_SOURCES)
  --no-robots               ignore robots.txt (env: SPIDERLINT_ROBOTS=false)
  --no-sitemap              skip sitemap discovery
                            (env: SPIDERLINT_SITEMAP=false)
  --no-keepalive            one connection per request
                            (env: SPIDERLINT_KEEPALIVE=false)
  --no-resources            skip scripts, styles, images and fonts
                            (env: SPIDERLINT_RESOURCES=false)
  --canonical-origin <url>  origin the pages are built for; its URLs count as
                            the crawled one’s
                            (env: SPIDERLINT_CANONICAL_ORIGIN)
  --role <role>             production, staging or development
                            (default: production, env: SPIDERLINT_ROLE)
  --resolver <list>         DNS servers to ask, address[:port],…
                            (default: system, env: SPIDERLINT_RESOLVER)
  --resolve <pin>           pin host[:port]:address instead of DNS, repeatable
                            (env: SPIDERLINT_RESOLVE)
  --no-allow-private        refuse loopback, private and link-local addresses
                            (env: SPIDERLINT_ALLOW_PRIVATE=false)
  --no-browser-install      fail on a missing browser, print its install command
                            (env: SPIDERLINT_BROWSER_INSTALL=false)

Store:
  --store <dir>             store directory
                            (default: /app/.cache/spiderlint/<host>)
  --resume                  continue an interrupted crawl
  --no-cache                neither read nor write the cache
                            (env: SPIDERLINT_CACHE=off)
  --refresh                 refetch everything, rewrite the cache
                            (env: SPIDERLINT_CACHE=refresh)
  --offline                 cache only, a miss exits 3
                            (env: SPIDERLINT_CACHE=offline)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Crawl now, lint later:
    spiderlint crawl example.com
  Continue a crawl that was interrupted:
    spiderlint crawl example.com --resume
```
