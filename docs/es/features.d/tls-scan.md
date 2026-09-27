<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Configuración TLS analizada en casa

- Se listan todos los protocolos y conjuntos de cifrado que acepta un servidor, incluidos SSLv2, SSLv3, RC4 y los de exportación, que las bibliotecas TLS actuales ya no pueden ver.
- Los conjuntos rotos y débiles, la falta de secreto hacia adelante, los primos Diffie-Hellman cortos y la compresión de registros son hallazgos, y también los ataques que abren: POODLE, BEAST, SWEET32, FREAK, Logjam, DROWN y CRIME.
- Una cadena de certificados sin sus intermedios se detecta también en servidores que solo hablan TLS 1.3.
- Una regla propia como «nada de conjuntos CBC» son unas líneas de configuración, no código.
- No se consulta a ningún escáner externo ni se explota nada: al servidor solo se le pregunta qué negociaría, una vez por origen mientras el resultado siga vigente.

<!-- textlint-enable -->
