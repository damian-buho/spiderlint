<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# spiderlint rulesets

```console
$ spiderlint rulesets --help
Usage: spiderlint rulesets [options]
Print the shipped ruleset catalog, or write one page per ruleset.

The catalog is YAML at org.projectfile.pages.rulesets.items; markdown writes one
page per ruleset and index.md into --output, linking each rule to its page in
the sibling rules directory.

Output:
  --format <format>  yaml or markdown (default: yaml)
  --lang <tag>       en, es, uk (default: from LC_ALL, LC_MESSAGES or LANG)
  --output <dir>     with --format markdown, the directory to write pages in

Options for every command, see spiderlint --help:
  --config, --site, --[no-]color, --[no-]progress, --log-level

Examples:
  Print the ruleset catalog:
    spiderlint rulesets
  Write the ruleset pages of a documentation book:
    spiderlint rulesets --format markdown --output book/rulesets
```
