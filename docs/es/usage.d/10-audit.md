<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Auditar un sitio

`audit` rastrea el sitio en el almacén local y luego lo revisa; `show-report` vuelve a imprimir el resultado guardado en otro formato, sin red.

```sh
spiderlint audit example.org
spiderlint show-report example.org --format sarif > spiderlint.sarif
```
