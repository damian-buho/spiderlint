<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Rastrear una vez, analizar muchas

- Un rastreo se puede guardar en disco y analizar de nuevo con reglas o grupos cambiados, sin acceso a la red.
- Un rastreo interrumpido se reanuda donde se detuvo.
- Un rastreo repetido solo pregunta al sitio si cada página, script y sitemap cambió, y no vuelve a descargar ni a analizar lo que no cambió.
- Las descargas binarias se juzgan por sus cabeceras y nunca se descargan completas, así que un archivo comprimido o un vídeo enlazado no consume ancho de banda.
- Una copia de staging se audita como el sitio para el que está construida, así que sus enlaces y su sitemap que nombran la dirección de producción no se informan como errores.

<!-- textlint-enable -->
