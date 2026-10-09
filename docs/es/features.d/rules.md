<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Más de 500 reglas, y las nuevas escritas como datos

- Una regla es una ruta de hecho más un JSON Schema, así que una comprobación nueva no requiere código.
- Los preajustes incluidos cubren buscadores, cabeceras de seguridad, TLS, DNS, cookies, rendimiento, accesibilidad, privacidad, sostenibilidad, enlaces, redirecciones, sitemaps, robots.txt, archivos well-known y archivos para agentes de IA.
- Cada grupo de URL ejecuta sus propios conjuntos de reglas, y la severidad de cualquier regla se puede cambiar o desactivar desde la línea de órdenes, el entorno o el projectfile.
- axe-core, html-validate y htmlhint se ejecutan dentro del mismo rastreo, cada una de sus comprobaciones es una regla que se puede ajustar o desactivar como cualquier otra, y las puntuaciones de Lighthouse se suman en las páginas renderizadas.
- Los complementos añaden sus propios hechos, reglas, preajustes, formatos de informe y fuentes de URL junto a los incluidos, y una simple lista de URL se puede auditar por sí sola.

<!-- textlint-enable -->
