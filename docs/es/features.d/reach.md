<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Sitios en cualquier red, rastreados con cortesía

- Los servicios onion y los sitios I2P se auditan con un solo ajuste, a través del proxy local de Tor o I2P, al ritmo y con los tiempos de espera que esas redes necesitan.
- Cada petición del rastreo simple y del rastreo con navegador puede pasar por un proxy HTTP, HTTPS o SOCKS, incluidos los proxies SOCKS que resuelven ellos mismos los nombres de host.
- Un servidor que responde «demasiadas peticiones» o «no disponible» se reintenta con espera creciente respetando su `Retry-After`, y un límite de peticiones por minuto mantiene el rastreo dentro de lo que el sitio tolera.
- robots.txt se obedece salvo que indiques lo contrario.

<!-- textlint-enable -->
