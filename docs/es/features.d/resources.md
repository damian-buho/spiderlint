<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Dependencias de página descargadas una sola vez

- Los scripts, hojas de estilo, imágenes y marcos que cargan las páginas se descargan una vez por ejecución, sea cual sea su origen.
- Una dependencia rota o insegura es un solo hallazgo con la lista de páginas que la usan, no un hallazgo por página.
- Se informan los scripts de otro origen sin hash de integridad y los recursos HTTP sin cifrar en páginas HTTPS.
- El manifiesto de la aplicación web se descarga y se juzga como cualquier otra dependencia.

<!-- textlint-enable -->
