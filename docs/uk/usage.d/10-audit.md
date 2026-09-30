<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Перевірте сайт

`audit` обходить сайт у локальне сховище, а потім перевіряє його; `show-report` знову друкує збережений результат в іншому форматі, без мережі.

```sh
spiderlint audit example.org
spiderlint show-report example.org --format sarif > spiderlint.sarif
```
