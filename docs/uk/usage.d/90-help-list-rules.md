<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint list-rules

```console
$ spiderlint list-rules --help
Usage: spiderlint list-rules [options] [ruleset|id…]
List rules at the severity this config gives.

Rule IDs and rulesets are comma-separated; an ID may be a glob such as
lighthouse/*.

Rules:
  --rules <rulesets>     rulesets or rule IDs to run in every group
                         (default: recommended, env: SPIDERLINT_RULES)
  --exclude-rules <ids>  skip these rules (env: SPIDERLINT_EXCLUDE_RULES)
  --error <ids>          report these rules as errors
                         (env: SPIDERLINT_OVERRIDE_ERROR)
  --warning <ids>        report these rules as warnings
                         (env: SPIDERLINT_OVERRIDE_WARNING)
  --info <ids>           report these rules as info
                         (env: SPIDERLINT_OVERRIDE_INFO)
  --hint <ids>           report these rules as hints: no grade, no failure
                         (env: SPIDERLINT_OVERRIDE_HINT)

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
