<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Cabeceras de seguridad evaluadas, no solo detectadas

- Content-Security-Policy se lee directiva por directiva, desde la cabecera o un `<meta>`: los scripts en línea sin nonce ni hash, `eval`, los scripts desde cualquier host y la falta de `object-src`, `base-uri`, `frame-ancestors` o Trusted Types son cada uno un hallazgo propio.
- HSTS debe durar lo suficiente y cubrir los subdominios, y las respuestas no deben poder ser olfateadas, enmarcadas por otros sitios ni filtrar URL completas por el referente.
- El aislamiento entre orígenes, Permissions-Policy y los puntos de notificación se revisan en cada página, no solo en la portada.
- Se informa de una cabecera X-XSS-Protection que aún activa el filtro retirado, porque ese filtro también se puede aprovechar.
- Una cabecera que rompe su propia gramática, como un max-age de HSTS que no es un número o una directiva de Cache-Control que ninguna caché conoce, es un solo hallazgo que nombra el fallo, en lugar de aprobar por estar presente o de fallar en cada comprobación que la lee.

<!-- textlint-enable -->
