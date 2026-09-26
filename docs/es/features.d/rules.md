<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Reglas como datos, con preajustes

- Una regla es una ruta de hecho más un JSON Schema, así que una comprobación nueva no requiere código.
- Los preajustes incluidos cubren SEO, cabeceras de seguridad, TLS, cookies, redirecciones, versiones de idioma, sitemaps, robots.txt, enlaces y recursos de página.
- Cada grupo de URL ejecuta sus propios conjuntos de reglas, y la severidad de cualquier regla se puede cambiar o desactivar desde la línea de órdenes, el entorno o el projectfile.
- El marcado de cada página se puede validar contra el estándar HTML y en busca de defectos de accesibilidad; un defecto que comparte toda una plantilla es un solo hallazgo, no uno por página.
- Los complementos añaden sus propios hechos, reglas y preajustes junto a los incluidos.

<!-- textlint-enable -->
