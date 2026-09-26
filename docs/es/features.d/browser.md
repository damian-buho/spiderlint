<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Páginas renderizadas en el cliente, auditadas tal como las ven los visitantes

- Una página cuyas etiquetas, enlaces o contenido aparecen solo después de ejecutar sus scripts se renderiza en un navegador real, así que se revisa lo que ven los buscadores y los visitantes.
- Solo se renderizan las secciones que necesitan un navegador; el resto del sitio se rastrea por HTTP simple a toda velocidad en la misma ejecución, y una sección que renderiza sus etiquetas en el cliente se puede detectar sola.
- Los errores de consola, los tiempos de carga y cada recurso que una página carga en tiempo de ejecución se convierten en hechos que las reglas pueden comprobar.
- La accesibilidad se comprueba en la página renderizada frente a WCAG A y AA, así que también se detectan los defectos que introducen los scripts.
- El uso con teclado, el movimiento y la velocidad se prueban en unas pocas páginas por plantilla: Tab debe alcanzar cada control y mostrar dónde está el foco, las animaciones deben detenerse cuando el visitante pide menos movimiento, y las puntuaciones de Lighthouse y las Core Web Vitals de laboratorio salen del mismo navegador.

<!-- textlint-enable -->
