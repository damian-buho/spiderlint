<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Transporte comprobado por página, no por host

- El certificado, el protocolo TLS y la dirección remota se leen de la conexión que sirvió cada página, así que dos backends tras un mismo nombre se informan en lugar de quedar ocultos.
- Los certificados a punto de caducar, los certificados rechazados y las versiones de TLS obsoletas son hallazgos.
- Los tiempos, las cadenas de redirección y los atributos de las cookies se registran para cada página, y los valores de las cookies nunca salen del rastreador.
- Se informa de una cookie que los navegadores rechazarían o acortarían sin avisar y de una precarga que una pista temprana promete y la página luego abandona.

<!-- textlint-enable -->
