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
- Los feeds de pódcast pueden revisarse, de forma opcional, en lo que exigen los directorios: las etiquetas de canal y de episodio de iTunes, un GUID estable de Podcasting 2.0, una política `podcast:locked` y una carátula que Apple acepta — JPEG o PNG cuadrado, de 1400 a 3000 px por lado.
- Cada adjunto se consulta una vez con HEAD y se juzga contra su declaración: alcance, coincidencia de bytes y de tipo, y soporte de rangos de bytes, que Apple exige a los servidores de episodios.
- Un hub WebSub declarado puede sondearse con una petición de descubrimiento, solo de forma opcional.
- Un directorio de pódcast exige RSS 2.0 con los espacios de nombres de iTunes y de contenido declarados, un adjunto único con URL, longitud y tipo por episodio, un GUID por episodio que nunca cambia y fechas RFC 2822.

<!-- textlint-enable -->
