<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# spiderlint lint

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
  --fail-on <level>      exit 1 at error, warning, info, or never (default:
                         error, env: SPIDERLINT_FAIL_ON)
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
