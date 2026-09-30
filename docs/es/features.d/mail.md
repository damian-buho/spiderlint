<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Autenticación del correo de cada dominio que recorre

- Detecta por sí solo si un dominio recibe o envía correo, y al que no hace ninguna de las dos cosas le mantiene las revisiones sin correo, así que nadie tiene que decir de qué tipo es.
- Recorre SPF a través de cada include igual que los receptores, así que un registro que falla en silencio por demasiadas consultas o un include que no existe sale a la luz antes de que el correo rebote.
- Revisa DMARC, DKIM y MX en busca de los fallos que castigan los receptores: varias políticas, direcciones de informes que los rechazan, claves cortas, claves que siguen en prueba y servidores de correo detrás de un CNAME.
- Lee MTA-STS, los informes de TLS y BIMI de principio a fin, así que detecta una política que deja fuera a un servidor de correo o un logotipo que ningún cliente de correo va a mostrar.
- DANE y una prueba STARTTLS en vivo de cada servidor de correo están disponibles cuando los activas.

<!-- textlint-enable -->
