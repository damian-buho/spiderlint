<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Un hallazgo por plantilla, no por página

- Las páginas se agrupan por patrón de URL, así que un defecto que comparten todas las entradas se informa una sola vez para su plantilla, con páginas de ejemplo; las comprobaciones costosas, como la accesibilidad, se ejecutan solo en unas pocas páginas de cada plantilla.
- Un grupo cuyas páginas discrepan en una regla recibe un aviso de que probablemente mezcla dos plantillas.
- Los valores que deben ser únicos en todo el sitio, como títulos y descripciones, se informan una vez por duplicado con todas las URL que lo comparten.
- Los resultados salen en texto, JSON o SARIF, así que las vistas de análisis de código muestran una fila por defecto.
- Cada ejecución termina con el número de comprobaciones superadas y una nota de la S a la F, para comparar sitios y versiones de un vistazo.

<!-- textlint-enable -->
