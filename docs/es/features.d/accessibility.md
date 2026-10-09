<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Accesibilidad revisada desde todos los lados

- Cada regla de axe-core para WCAG 2.2 A y AA, y sus buenas prácticas, se ejecuta en la página renderizada, así que también se detectan los defectos que introducen los scripts.
- El marcado de cada página, no de una muestra, se revisa en busca de los defectos de accesibilidad que html-validate ve sin navegador: etiquetas que faltan, niveles de encabezado saltados, texto alternativo ausente.
- El uso con teclado se prueba en unas pocas páginas por plantilla: Tab debe alcanzar cada control sin quedar atrapado, el foco debe verse y no quedar tapado, un enlace para saltar al contenido debe ir primero, y se informa de los manejadores de clic en elementos simples.
- Se respetan los ajustes del visitante: las animaciones se detienen con movimiento reducido, el texto sigue legible en el esquema oscuro y en el contraste alto que ofrece la página, el foco y los iconos sobreviven al contraste alto de Windows, y los campos de formulario son lo bastante grandes para que los teléfonos no amplíen.

<!-- textlint-enable -->
