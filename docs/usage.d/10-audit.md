<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Audit a site

`audit` crawls the site into the local store, then lints it; `show-report` prints the stored result again in another format, with no network.

```sh
spiderlint audit example.org
spiderlint show-report example.org --format sarif > spiderlint.sarif
```
