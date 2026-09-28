<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Informes para personas, canalizaciones y agentes de código

- Los hallazgos salen en texto, JSON, SARIF, Checkstyle, CSV o un informe HTML, y un rastreo guardado se vuelve a formatear sin pedir de nuevo el sitio.
- Cada hallazgo puede decir cómo corregirlo en el sitio auditado, con el registro, la cabecera o la etiqueta exactos y los nombres del propio sitio ya puestos, y el análisis de código muestra la misma guía junto a cada alerta.
- El formato agent convierte los hallazgos en instrucciones de corrección para un agente de código, ordenadas por severidad y por cuántas páginas arregla cada corrección.
- Una acción de CI audita un sitio en cada push, hace fallar el trabajo en la severidad que elijas, sube el SARIF al análisis de código y guarda el rastreo en caché, así que volver a auditar un sitio sin cambios cuesta casi nada.
- Los códigos de salida distinguen los hallazgos de una configuración errónea y de un sitio que no se pudo alcanzar, para que una canalización sepa qué falló.

<!-- textlint-enable -->
