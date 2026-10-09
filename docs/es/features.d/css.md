<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# CSS revisado como lo leen los navegadores

- Las hojas de estilo y el CSS en línea se analizan en busca de lo que los navegadores descartan sin avisar: errores de sintaxis que pierden una regla entera, propiedades mal escritas y valores fuera de la gramática de la propiedad.
- Cada defecto indica su línea y columna, en la hoja de estilo o en la página que contiene el bloque en línea.
- Una hoja de estilo que cargan todas las páginas es un solo hallazgo con las páginas que la usan, y el CSS en línea se agrupa por plantilla.
- Las características que no tienen los navegadores declarados por el proyecto se listan junto con esos navegadores, y el código dentro de `@supports` no se toca.
- Los prefijos de proveedor y los trucos para navegadores antiguos nunca se informan, y la revisión no necesita un validador en Java.

<!-- textlint-enable -->
