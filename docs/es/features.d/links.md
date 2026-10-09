<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Enlaces rotos, dentro y fuera del sitio

- Un enlace que no lleva a ninguna parte, a este sitio o a otro, es un solo hallazgo con la lista de páginas que lo contienen.
- Los enlaces a otros sitios se comprueban una vez por ejecución y se recuerdan durante una semana, así que una nueva ejecución no les envía nada.
- Un sitio que solo pide al verificador que vaya más despacio no se informa como roto.
- Los feeds que una página anuncia en su cabecera también se rastrean y comprueban, aunque ningún enlace apunte a ellos.
- Se detectan los enlaces internos marcados nofollow, los enlaces a contenido pagado o de usuarios pueden sujetarse a una política rel que declara el propietario, y se informa de un perfil que el sitio reclama como propio pero que no enlaza de vuelta, como exige la verificación de Mastodon.

<!-- textlint-enable -->
