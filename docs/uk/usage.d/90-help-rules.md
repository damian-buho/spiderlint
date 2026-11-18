<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint rules

```console
$ spiderlint rules --help
Usage: spiderlint rules [options]
Print the shipped rule catalog, or write one page per rule family.

The catalog is YAML at org.projectfile.pages.rules.items; markdown writes one
page per rule family and index.md into --output.

Output:
  --format <format>  yaml or markdown (default: yaml)
  --lang <tag>       en, es, uk (default: from LC_ALL, LC_MESSAGES or LANG)
  --output <dir>     with --format markdown, the directory to write pages in

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Print the rule catalog in Spanish:
    spiderlint rules --lang es
  Write the rule pages of a documentation book:
    spiderlint rules --format markdown --output book/rules
```
