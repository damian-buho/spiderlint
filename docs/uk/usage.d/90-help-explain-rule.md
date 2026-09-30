<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# spiderlint explain-rule

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
