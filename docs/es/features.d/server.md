<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Servidor de análisis

- La misma imagen funciona como API HTTP con cola de trabajos, de modo que un equipo o el público puede pedir auditorías sin instalar nada.
- Cada análisis informa de su progreso mientras se ejecuta, y su informe se descarga en todos los formatos que produce la línea de órdenes.
- Quien administra la instancia define políticas por dominio: vetar un dominio de nivel superior, limitar la frecuencia con que se analiza un host, acotar páginas y tiempo, y elegir qué reglas pueden ejecutarse.
- Las políticas se recargan desde un archivo montado sin reiniciar.
- Un análisis no puede dirigirse a direcciones de bucle local, privadas ni de metadatos de la nube.

<!-- textlint-enable -->
