<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# El DNS detrás de cada host rastreado

- Se informa de la falta de registros HTTPS, para que una primera visita pueda empezar en HTTP/3 sin un viaje extra para descubrirlo.
- CAA se juzga contra el certificado que el sitio sirve de verdad, así que una CA que CAA prohíbe se detecta antes de que falle una renovación.
- DNSSEC se comprueba de extremo a extremo: una zona sin firmar, algoritmos débiles, firmas que ya no se renuevan y una zona firmada que los resolvedores con validación rechazan.
- Se pregunta directamente a los servidores de nombres y cualquier otra consulta va solo al resolvedor que indiques, así que un servidor cojo o una zona desincronizada salen a la luz, y un enlace a un subdominio cuyo CNAME no apunta a nada se marca como riesgo de secuestro.
- A un dominio que no envía ni recibe correo se le puede exigir un MX nulo, un SPF que lo rechaza todo y una política DMARC de rechazo, para que nadie envíe correo en su nombre.
- El registro del dominio se lee de su registro, así que una renovación a pocos días, un bloqueo de transferencia ausente o un registro que nombra otros servidores de nombres que la zona se ven antes de que el dominio caduque o se lo lleven.
- Cada dirección se atribuye a la red que la enruta, así que salen a la luz una ruta que las redes que aplican RPKI descartan, un servidor de correo sin DNS inverso que coincida, o un sitio y sus servidores de nombres detrás de un solo proveedor.

<!-- textlint-enable -->
