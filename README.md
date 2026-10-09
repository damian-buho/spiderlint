<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
pf-cli-managed: yes
-->

[Español](docs/es/README.md) · [Українська](docs/uk/README.md)

# Spiderlint

Spiderlint crawls every page a site serves, collects facts about each request (HTML, headers, TLS, timings, sizes) and lints them against rulesets scoped by URL group, so a template missing a heading is one finding rather than one per page. Built on Node and Crawlee.

[![Stand with Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://damian-buho.github.io/support-ukraine/) [![Projectfile inside](https://badges.kiota.ch/static/v1?label=projectfile&message=inside&labelColor=0d0d0d&color=8c6723&style=flat-square)](https://projectfile.org) [![License](https://badges.kiota.ch/static/v1?label=license&message=AGPL-3.0-only&color=1e5913&style=flat-square)](LICENSE) [![Cosign](https://badges.kiota.ch/static/v1?label=cosign&message=enabled&color=1e5913&style=flat-square)](https://docs.sigstore.dev/cosign/verifying/verify/) ![ClamAV scanned](https://badges.kiota.ch/static/v1?label=clamav&message=scanned&color=1877aa&style=flat-square) [![PRs welcome](https://badges.kiota.ch/static/v1?label=PRs&message=welcome&color=1e5913&style=flat-square)](CONTRIBUTING.md) [![REUSE compliance](https://api.reuse.software/badge/codeberg.org/damian-buho/spiderlint)](https://api.reuse.software/info/codeberg.org/damian-buho/spiderlint)

![Project status](https://badges.kiota.ch/static/v1?label=status&message=experimental&color=1d63ed&style=flat-square) [![Last commit on kiota.ch](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://kiota.ch&label=last%20commit%20on%20kiota.ch&style=flat-square)](https://kiota.ch/damian-buho/spiderlint) [![Last commit on Codeberg](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://codeberg.org&label=last%20commit%20on%20Codeberg&style=flat-square)](https://codeberg.org/damian-buho/spiderlint) [![Last commit on GitHub](https://badges.kiota.ch/github/last-commit/damian-buho/spiderlint?label=last%20commit%20on%20GitHub&style=flat-square)](https://github.com/damian-buho/spiderlint)

[![Publish pipeline on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/published.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Vulnerability audit on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/audited.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Dependency freshness on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Analysis sweep on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions)

[![Publish pipeline on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/published.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Vulnerability audit on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/audited.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Dependency freshness on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Analysis sweep on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions)

## Features

- Accessibility checked from every side
- Client-rendered pages audited as visitors see them
- Every kind of page early, whatever the limit
- CSS checked as browsers read it
- The DNS behind every crawled host
- Feeds checked the way readers see them
- One finding per template, not per page
- Icons fetched and measured
- Image weight measured, not estimated
- The site measured as a whole
- Dead links, on the site and off it
- Mail authentication of every domain it crawls
- Each origin checked once, beyond its pages
- Structured data and markup checked on every page
- Speed problems found without a browser
- Privacy before consent
- Sites on any network, crawled politely
- Reports for people, pipelines and coding agents
- Page dependencies fetched once
- robots.txt read the way crawlers read it
- Over 500 rules, and new ones written as data
- Search visibility checked across the whole site
- Security headers judged, not just detected
- Scan server
- Crawl once, lint many times
- The footprint of every page view
- TLS configuration scanned in-house
- Transport checked per page, not per host
- What the CDN or host adds, kept apart
- The files a site publishes beside its pages

It also inherits the features of B19 / Ubuntu — see [Features](docs/FEATURES.md) for the full list.

## What this provides

- **CI action** `damian-buho/spiderlint@0.141.0`
- **Container image** `ghcr.io/damian-buho/spiderlint:latest`
- **Container image** `damianbuho/spiderlint:latest`
- `spiderlint` — command `spiderlint`

## Installation

Pull the published container image:

### Pull from GHCR — linux/amd64

```sh
docker pull ghcr.io/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws ghcr.io/damian-buho/spiderlint:latest spiderlint'
```

### Pull from DockerHub — linux/amd64

```sh
docker pull damianbuho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws damianbuho/spiderlint:latest spiderlint'
```

Stable releases also publish `X.Y.Z`, `X.Y` and `X` tags — pull the precision you want to pin.

If the registries above are unreachable, pull from the origin instead:

### Pull from Kiota — linux/amd64

```sh
docker pull kiota.ch/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws kiota.ch/damian-buho/spiderlint:latest spiderlint'
```

Then run it as if it were installed — the alias runs every example as written against the current directory:

```sh
spiderlint --help
```

## Usage

Run it as a step in a GitHub Actions workflow:

```yaml
- uses: damian-buho/spiderlint@0.141.0
```

The action takes these inputs:

| Input | Default | Description |
| --- | --- | --- |
| `urls` | | Newline-separated seed URLs. Empty takes the targets from the config file. |
| `config_file` | | Projectfile or plain YAML carrying the org.spiderlint subtree, relative to the workspace. |
| `site` | | One org.spiderlint.sites name to audit; a config declaring several needs one step per site. |
| `rules` | | Comma-separated rulesets replacing every group’s rules (e.g. recommended,axe). |
| `args` | | More audit flags, one per line with its value after a space (e.g. --max-pages 200). |
| `fail_on` | `error` | Severity that fails the job: error \| warning \| info \| never |
| `upload_sarif` | `false` | Upload the SARIF report to code scanning; needs the security-events: write permission. |
| `cache` | `true` | Keep the crawl store in the forge cache, so an unchanged site is re-audited with 304s. |
| `version` | | Image tag to pull (e.g. latest, 1.2.3). Empty follows the action’s own version tag, else latest. |
| `image` | | Full image reference. Takes precedence over `version`. |

### spiderlint

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
  list-presets                    list the shipped rulesets and their groups
  explain-rule <rule>             show a rule’s facts, expectation and fix

Cache:
  show-cache [domain…]            show the entries, bytes and age of each bucket
  purge-cache [bucket] [domain…]  delete a site’s cached entries
  warm-cache [domain…]            fetch robots.txt and sitemaps without crawling

Commands:
  help [command]                  show a command’s options and examples

Options:
  --config <path>                 settings file
                                  (default: projectfile.yaml)
                                  (env: SPIDERLINT_CONFIG)
  --site <names>                  only these org.spiderlint.sites, repeatable
                                  (default: all)
  --[no-]color                    force or disable color
                                  (default: auto, env: NO_COLOR, FORCE_COLOR)
  --[no-]progress                 status line on an interactive stderr
                                  (default: auto)
  --log-level <level>             trace, debug, info, warn, error or silent
                                  (default: warn, env: SPIDERLINT_LOG_LEVEL)
  -V, --version                   show the version
  -h, --help                      show this screen, or a command’s

Run spiderlint <command> --help for a command’s options and examples.

Exit codes:
  0  clean
  1  findings at or above --fail-on
  2  usage or config error
  3  nothing fetched, or an --offline cache miss
  4  the run failed
```

Examples and every command’s help are in [Usage](docs/USAGE.md).

## Building

Clone the repository with its submodules:

```sh
git clone --recurse-submodules https://codeberg.org/damian-buho/spiderlint spiderlint && cd spiderlint
```

Build the container image locally:

```sh
make container-build
```

- [Makefile reference](docs/how-to/MAKEFILE.md)

Run `make` with no arguments for the default target; run `make help` to list every target.

For the local dev loop, `make dev-container` brings up the dev-container.

Pipeline entry points:

- `make analyzed` — Run the heavy analysis sweep (mutation testing, benchmarks)
- `make audited` — Re-scan the pinned dependencies and published artifacts for new vulnerabilities
- `make check-outdated` — Report every pinned dependency that lags upstream
- `make ready-to-publish` — Run the pseudo-CI pipeline locally — build, test and scan, without publishing

## Documentation

- [Run spiderlint from a checkout](docs/how-to/RUN-FROM-A-CHECKOUT.md)

## Policies

- [How to contribute](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Getting support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [AI and LLM Policy](AI_POLICY.md)

## Links

- [Issues on GitHub](https://github.com/damian-buho/spiderlint/issues)
- [Projectfile Specification](https://projectfile.org)

## License

This project is licensed under AGPL-3.0-only — see the [LICENSE](LICENSE) file for details.
