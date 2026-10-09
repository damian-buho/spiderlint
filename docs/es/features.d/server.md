<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Servidor de análisis

- La misma imagen funciona como API HTTP con cola de trabajos y como página web donde cualquiera escribe un dominio y lee el informe en inglés, español o ucraniano, con o sin JavaScript.
- Cada análisis informa de su progreso mientras se ejecuta, su informe se descarga en todos los formatos que produce la línea de órdenes, y un sitio puede mostrar su última calificación como una insignia que enlaza al informe.
- Quien administra la instancia define políticas por dominio: vetar un dominio de nivel superior, limitar la frecuencia con que se analiza un host, acotar páginas y tiempo, y elegir qué reglas pueden ejecutarse. Repetir una petición dentro de una ventana fijada devuelve el análisis ya hecho, y cada cliente tiene su propio límite.
- Las políticas se recargan desde un archivo montado sin reiniciar.
- Un análisis no puede dirigirse a direcciones de bucle local, privadas ni de metadatos de la nube.

<!-- textlint-enable -->
