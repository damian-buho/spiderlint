<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Feeds revisados tal como los ven los lectores

- Los feeds RSS, Atom y JSON se revisan según su propia especificación: campos obligatorios, fechas que los lectores puedan leer e identificadores que nunca se repiten ni cambian, para que nadie vea una entrada antigua como nueva.
- El contenido de cada entrada se lee como lo muestra un lector: Markdown o MDX sin convertir, marcadores de plantilla, enlaces e imágenes relativos, doble escapado y marcado que los lectores eliminan, cada uno con la entrada en la que aparece.
- Cada entrada se compara con la página a la que enlaza: un enlace que falla o redirige, un título, una fecha o un idioma que no coinciden, o una URL canónica que el feed esquiva.
- También se juzga cómo se sirve el feed para su consulta periódica: su tipo y codificación, las peticiones condicionales, la caché, el tamaño y una hoja XSL que Chrome ya no aplica.
- Los feeds de pódcast pueden revisarse, de forma opcional, en lo que exigen los directorios.

<!-- textlint-enable -->
