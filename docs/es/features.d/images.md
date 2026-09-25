<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Peso de imágenes medido, no estimado

- Cada imagen que carga el sitio se recodifica una vez, y se informan los bytes que ahorrarían AVIF, WebP o una codificación más ajustada de su propio formato.
- Cada imagen pesada es un solo hallazgo con las páginas que la usan, en todo el sitio y no en una muestra de páginas.
- Se señalan por plantilla las imágenes que envían muchos más píxeles de los que muestran, o que no tienen ancho y alto para reservar su espacio.
- Las mediciones se guardan en caché con la imagen, así que una nueva ejecución solo mide lo que cambió.

<!-- textlint-enable -->
