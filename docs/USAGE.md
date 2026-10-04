<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

[Español](es/USAGE.md) · [Українська](uk/USAGE.md)

# Usage

## spiderlint

```console
$ spiderlint --help
spiderlint
Site-wide linter for SEO tags, security headers, TLS and links
https://dbuho.me/project/spiderlint/

Usage: spiderlint <command> [domain…] [options]
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.

Check a site:
  audit [domain…]                 crawl a site, then lint it
  crawl [domain…]                 fetch pages into the store, lint nothing
  lint [domain…]                  lint the stored pages, with no network
  show-report [domain…]           print the stored report again, in any format

Inspect:
  show-facts <url>                fetch one page and print its facts
  export-facts [domain…]          print every stored page’s facts, no network
  list-groups [domain…]           count the pages in each URL group

Rules:
  list-rules [ruleset|id…]        list rules at the severity this config gives
  list-presets                    list shipped rulesets and the groups using
                                  them
  explain-rule <rule>             show what a rule reads and expects, and its
                                  fix

Cache:
  show-cache [domain…]            show the entries, bytes and age of each bucket
  purge-cache [bucket] [domain…]  delete a site’s cached entries
  warm-cache [domain…]            fetch robots.txt and sitemaps without crawling

Commands:
  help [command]                  show a command’s options and examples

Options:
  --config <path>                 settings file (default: projectfile.yaml, env:
                                  SPIDERLINT_CONFIG)
  --site <names>                  only these org.spiderlint.sites, repeatable
                                  (default: all)
  --[no-]color                    force or disable color (default: auto, env:
                                  NO_COLOR, FORCE_COLOR)
  --[no-]progress                 status line on an interactive stderr (default:
                                  auto)
  --log-level <level>             trace, debug, info, warn, error or silent
                                  (default: info, env: SPIDERLINT_LOG_LEVEL)
  -V, --version                   show the version
  -h, --help                      show this screen, or a command’s with the
                                  command

Run spiderlint <command> --help for a command’s options and examples.

Exit codes:
  0  clean
  1  findings at or above --fail-on
  2  usage or config error
  3  nothing fetched, or an --offline cache miss
  4  the run failed
```

## Audit a site

`audit` crawls the site into the local store, then lints it; `show-report` prints the stored result again in another format, with no network.

```sh
spiderlint audit example.org
spiderlint show-report example.org --format sarif > spiderlint.sarif
```

## Explain a rule

`explain-rule` prints what a rule reads, what it expects and how to fix a finding, with no network.

```console
$ spiderlint explain-rule cookies/host-prefix
cookies/host-prefix
severity warning (preset warning)
score    5.0
scope    page
kind     declarative
rulesets cookies
reads    http.cookies
expect   {"type":"array","items":{"if":{"properties":{"name":{"pattern":"^(?i:__Host-)"}}},"then":{"properties":{"secure":{"const":true},"path":{"const":"/"}},"required":["path"],"not":{"required":["domain"]}}}}
message  a __Host- cookie lacks Secure or Path=/, or sets Domain, so browsers reject it
fix      Add Secure and Path=/, and omit Domain, from every __Host- cookie.
docs     https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes
```

## spiderlint audit

```console
$ spiderlint audit --help
Usage: spiderlint audit [options] [domain…]
Crawl a site, then lint it.

Keeps the pages in the store, so lint and show-report reuse them offline.
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.
Rule IDs and rulesets are comma-separated; an ID may be a glob such as
lighthouse/*.

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

Rules:
  --rules <rulesets>        rulesets or rule IDs to run in every group (default:
                            recommended, env: SPIDERLINT_RULES)
  --exclude-rules <ids>     skip these rules (env: SPIDERLINT_EXCLUDE_RULES)
  --error <ids>             report these rules as errors (env:
                            SPIDERLINT_OVERRIDE_ERROR)
  --warning <ids>           report these rules as warnings (env:
                            SPIDERLINT_OVERRIDE_WARNING)
  --info <ids>              report these rules as info (env:
                            SPIDERLINT_OVERRIDE_INFO)
  --hint <ids>              report these rules as hints, which neither grade nor
                            fail (env: SPIDERLINT_OVERRIDE_HINT)

Report:
  --format <format>         human, json, sarif, checkstyle, csv, html, agent or
                            a plugin’s (default: human, env: SPIDERLINT_FORMAT)
  --fail-on <level>         exit 1 at error, warning, info, a score from 0.1 to
                            9.9, or never (default: error, env:
                            SPIDERLINT_FAIL_ON)
  --unfold                  one finding per page, every URL and location listed
                            (env: SPIDERLINT_FOLD=false)
  --show-hints              list hints in human output, not only their count
  --explain                 print each finding’s fix and docs in human output
  --stats                   count, min, median, p95, max and total of each
                            numeric fact
  --output <dir>            with --format agent, one Markdown prompt per rule in
                            dir

Store:
  --store <dir>             store directory (default:
                            /app/.cache/spiderlint/<host>)
  --resume                  continue an interrupted crawl
  --no-cache                neither read nor write the cache (env:
                            SPIDERLINT_CACHE=off)
  --refresh                 refetch everything, rewrite the cache (env:
                            SPIDERLINT_CACHE=refresh)
  --offline                 cache only, a miss exits 3 (env:
                            SPIDERLINT_CACHE=offline)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Audit a site with the recommended rules:
    spiderlint audit example.com
  Write a SARIF report for code scanning:
    spiderlint audit example.com --format sarif > report.sarif
  Run every rule except Lighthouse’s:
    spiderlint audit example.com --rules all --exclude-rules 'lighthouse/*'
  Check a single rule:
    spiderlint audit example.com --rules http/alt-svc-h3
  Audit only the URLs listed in a file:
    spiderlint audit --source list:urls.txt
```

## spiderlint crawl

```console
$ spiderlint crawl --help
Usage: spiderlint crawl [options] [domain…]
Fetch pages into the store, lint nothing.

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

Store:
  --store <dir>             store directory (default:
                            /app/.cache/spiderlint/<host>)
  --resume                  continue an interrupted crawl
  --no-cache                neither read nor write the cache (env:
                            SPIDERLINT_CACHE=off)
  --refresh                 refetch everything, rewrite the cache (env:
                            SPIDERLINT_CACHE=refresh)
  --offline                 cache only, a miss exits 3 (env:
                            SPIDERLINT_CACHE=offline)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Crawl now, lint later:
    spiderlint crawl example.com
  Continue a crawl that was interrupted:
    spiderlint crawl example.com --resume
```

## spiderlint explain-rule

```console
$ spiderlint explain-rule --help
Usage: spiderlint explain-rule [options] <rule>
Show what a rule reads and expects, and its fix.

Output:
  --format <format>  human or json (default: human, env: SPIDERLINT_FORMAT)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Explain a rule before turning it on:
    spiderlint explain-rule html/theme-color-schemes
```

## spiderlint export-facts

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

## spiderlint lint

```console
$ spiderlint lint --help
Usage: spiderlint lint [options] [domain…]
Lint the stored pages, with no network.

A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.
Rule IDs and rulesets are comma-separated; an ID may be a glob such as
lighthouse/*.

Rules:
  --rules <rulesets>     rulesets or rule IDs to run in every group (default:
                         recommended, env: SPIDERLINT_RULES)
  --exclude-rules <ids>  skip these rules (env: SPIDERLINT_EXCLUDE_RULES)
  --error <ids>          report these rules as errors (env:
                         SPIDERLINT_OVERRIDE_ERROR)
  --warning <ids>        report these rules as warnings (env:
                         SPIDERLINT_OVERRIDE_WARNING)
  --info <ids>           report these rules as info (env:
                         SPIDERLINT_OVERRIDE_INFO)
  --hint <ids>           report these rules as hints, which neither grade nor
                         fail (env: SPIDERLINT_OVERRIDE_HINT)

Report:
  --format <format>      human, json, sarif, checkstyle, csv, html, agent or a
                         plugin’s (default: human, env: SPIDERLINT_FORMAT)
  --fail-on <level>      exit 1 at error, warning, info, a score from 0.1 to
                         9.9, or never (default: error, env: SPIDERLINT_FAIL_ON)
  --unfold               one finding per page, every URL and location listed
                         (env: SPIDERLINT_FOLD=false)
  --show-hints           list hints in human output, not only their count
  --explain              print each finding’s fix and docs in human output
  --stats                count, min, median, p95, max and total of each numeric
                         fact
  --output <dir>         with --format agent, one Markdown prompt per rule in
                         dir

Store:
  --store <dir>          store directory (default:
                         /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Lint the last crawl, failing on warnings too:
    spiderlint lint example.com --fail-on warning
  Try every rule on the same pages:
    spiderlint lint example.com --rules all
```

## spiderlint list-groups

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

## spiderlint list-presets

```console
$ spiderlint list-presets --help
Usage: spiderlint list-presets [options]
List shipped rulesets and the groups using them.

Output:
  --format <format>  human or json (default: human, env: SPIDERLINT_FORMAT)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  See which presets exist:
    spiderlint list-presets
```

## spiderlint list-rules

```console
$ spiderlint list-rules --help
Usage: spiderlint list-rules [options] [ruleset|id…]
List rules at the severity this config gives.

Rule IDs and rulesets are comma-separated; an ID may be a glob such as
lighthouse/*.

Rules:
  --rules <rulesets>     rulesets or rule IDs to run in every group (default:
                         recommended, env: SPIDERLINT_RULES)
  --exclude-rules <ids>  skip these rules (env: SPIDERLINT_EXCLUDE_RULES)
  --error <ids>          report these rules as errors (env:
                         SPIDERLINT_OVERRIDE_ERROR)
  --warning <ids>        report these rules as warnings (env:
                         SPIDERLINT_OVERRIDE_WARNING)
  --info <ids>           report these rules as info (env:
                         SPIDERLINT_OVERRIDE_INFO)
  --hint <ids>           report these rules as hints, which neither grade nor
                         fail (env: SPIDERLINT_OVERRIDE_HINT)

Output:
  --format <format>      human or json (default: human, env: SPIDERLINT_FORMAT)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  List the security header rules:
    spiderlint list-rules security-headers
  List every rule as JSON:
    spiderlint list-rules --format json
```

## spiderlint purge-cache

```console
$ spiderlint purge-cache --help
Usage: spiderlint purge-cache [options] [bucket] [domain…]
Delete a site’s cached entries.

A bucket is one of pages, probes, resources, robots, sitemaps, origins, dns,
extractors; with none, every bucket is purged.
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

## spiderlint show-cache

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

## spiderlint show-facts

```console
$ spiderlint show-facts --help
Usage: spiderlint show-facts [options] <url>
Fetch one page and print its facts.

Facts are what spiderlint records about a page, such as headers, HTML, TLS,
timings and sizes; rules judge them. The site’s own facts are under site.
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.

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

Output:
  --format <format>         human, json, yaml, csv (default: human)
  --facts <glob>            fact paths to show, repeatable

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  See every fact about the home page:
    spiderlint show-facts example.com
  Print one page’s facts as JSON:
    spiderlint show-facts example.com/about/ --format json
```

## spiderlint show-report

```console
$ spiderlint show-report --help
Usage: spiderlint show-report [options] [domain…]
Print the stored report again, in any format.

A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.
With no domain, the targets come from org.spiderlint in the config, one run per
site.

Report:
  --format <format>  human, json, sarif, checkstyle, csv, html, agent or a
                     plugin’s (default: human, env: SPIDERLINT_FORMAT)
  --fail-on <level>  exit 1 at error, warning, info, a score from 0.1 to 9.9, or
                     never (default: error, env: SPIDERLINT_FAIL_ON)
  --unfold           one finding per page, every URL and location listed (env:
                     SPIDERLINT_FOLD=false)
  --show-hints       list hints in human output, not only their count
  --explain          print each finding’s fix and docs in human output
  --stats            count, min, median, p95, max and total of each numeric fact
  --output <dir>     with --format agent, one Markdown prompt per rule in dir

Store:
  --store <dir>      store directory (default: /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Turn the last report into a web page:
    spiderlint show-report example.com --format html > report.html
```

## spiderlint warm-cache

```console
$ spiderlint warm-cache --help
Usage: spiderlint warm-cache [options] [domain…]
Fetch robots.txt and sitemaps without crawling.

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

Store:
  --store <dir>             store directory (default:
                            /app/.cache/spiderlint/<host>)

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Prefetch robots.txt and sitemaps before an --offline run:
    spiderlint warm-cache example.com
```
