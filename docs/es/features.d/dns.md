<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# El DNS detrás de cada host rastreado

- Se informa de la falta de registros HTTPS, para que una primera visita pueda empezar en HTTP/3 sin un viaje extra para descubrirlo.
- CAA se juzga contra el certificado que el sitio sirve de verdad, así que una CA que CAA prohíbe se detecta antes de que falle una renovación.
- DNSSEC se comprueba de extremo a extremo: una zona sin firmar, algoritmos débiles, firmas que ya no se renuevan y una zona firmada que los resolvedores con validación rechazan.
- Se pregunta directamente a los servidores de nombres, así que un servidor cojo o una zona desincronizada salen a la luz, y un enlace a un subdominio cuyo CNAME no apunta a nada se marca como riesgo de secuestro.
- Las consultas van solo al resolvedor que indiques y se reutilizan mientras los registros lo permitan.

<!-- textlint-enable -->
