<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Iconos descargados y medidos

- Cada icono que nombran las páginas, el manifiesto de la aplicación web y `browserconfig.xml` se descarga una vez y se mide, así que un icono realmente más pequeño de lo que declara, o de otro formato, es un hallazgo.
- El favicon, el icono táctil de Apple, el icono SVG, la pestaña fijada de Safari y los mosaicos de Windows se juzgan cada uno según lo que la plataforma pide de verdad, como un PNG opaco de 180×180 para iOS.
- Una página que no enlaza ningún icono táctil de Apple se comprueba contra la ruta que iOS pide de todos modos.

<!-- textlint-enable -->
