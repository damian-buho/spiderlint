<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Cada origen comprobado una vez, más allá de sus páginas

- Se pide a propósito una página inexistente, así que un falso 404, o una página de error que filtra una traza de pila o la versión del servidor, es un hallazgo.
- Cada entrada — http o https, con o sin `www.`, en la raíz o en una página interior — debe llegar a un único origen canónico con una redirección permanente que conserve la ruta, y la página de inicio no debe redirigir a los visitantes según su idioma.
- Se informa de los archivos de política entre dominios que permiten a cualquier otro sitio leer páginas con la sesión del visitante.
- Los plugins añaden sus propias comprobaciones por origen o por host; sus resultados se reutilizan entre ejecuciones y sus peticiones nunca salen del host que comprueban.

<!-- textlint-enable -->
