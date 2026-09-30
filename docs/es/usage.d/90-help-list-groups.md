<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# spiderlint list-groups

```console
$ spiderlint list-groups --help
Usage: spiderlint list-groups [options] [domain…]
Count the pages in each URL group.

Crawls the site and names the pages no group in org.spiderlint.groups matched.
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.

Crawl:
  --fetch <mode>            auto, http, browser or adaptive (default: auto, env:
                            SPIDERLINT_FETCH)
  --browser <name>          chromium, firefox or webkit (default: chromium, env:
                            SPIDERLINT_BROWSER)
  --scope <scope>           follow links within the origin, host or domain
                            (default: origin, env: SPIDERLINT_SCOPE)
  --concurrency <n>         pages in flight, 0 for one per CPU, halved in a
                            browser (default: 0, env: SPIDERLINT_CONCURRENCY)
  --rate <n>                requests per minute, 0 for no limit (default: 0,
                            env: SPIDERLINT_RATE)
  --timeout <seconds>       seconds one page may take (default: 60, env:
                            SPIDERLINT_TIMEOUT)
  --profile <name>          tor or i2p: its local proxy, concurrency 4, timeout
                            240 (env: SPIDERLINT_PROFILE)
  --proxy <url>             http, https or socks5h proxy for every request (env:
                            SPIDERLINT_PROXY)
  --max-pages <n>           page limit, 0 for none (default: 0, env:
                            SPIDERLINT_MAX_PAGES)
  --max-depth <n>           link depth limit, 0 for none (default: 0, env:
                            SPIDERLINT_MAX_DEPTH)
  --max-body-size <bytes>   body size cap (default: 10000000, env:
                            SPIDERLINT_MAX_BODY_SIZE)
  --include-urls <glob>     crawl only URLs whose path and query match,
                            repeatable (env: SPIDERLINT_INCLUDE_URLS)
  --exclude-urls <glob>     skip URLs whose path and query match, repeatable
                            (env: SPIDERLINT_EXCLUDE_URLS)
  --source <id:arg>         add a plugin source’s URLs; list:FILE crawls a URL
                            list only, repeatable (env: SPIDERLINT_SOURCES)
  --no-robots               ignore robots.txt (env: SPIDERLINT_ROBOTS=false)
  --no-sitemap              skip sitemap discovery (env:
                            SPIDERLINT_SITEMAP=false)
  --no-keepalive            one connection per request (env:
                            SPIDERLINT_KEEPALIVE=false)
  --no-resources            skip scripts, styles, images and fonts (env:
                            SPIDERLINT_RESOURCES=false)
  --canonical-origin <url>  origin the pages are built for; its URLs count as
                            the crawled one’s (env: SPIDERLINT_CANONICAL_ORIGIN)
  --role <role>             production, staging or development (default:
                            production, env: SPIDERLINT_ROLE)
  --resolver <list>         DNS servers to ask, address[:port],… (default:
                            system, env: SPIDERLINT_RESOLVER)
  --resolve <pin>           connect to host[:port]:address instead of resolving
                            host, repeatable (env: SPIDERLINT_RESOLVE)
  --no-allow-private        refuse loopback, private and link-local addresses
                            (env: SPIDERLINT_ALLOW_PRIVATE=false)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Check the groups match the site’s templates:
    spiderlint list-groups example.com --max-pages 200
```
