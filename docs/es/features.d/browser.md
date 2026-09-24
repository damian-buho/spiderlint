<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Páginas renderizadas en el cliente, auditadas tal como las ven los visitantes

- Una página cuyas etiquetas, enlaces o contenido aparecen solo después de ejecutar sus scripts se renderiza en un navegador real, así que se revisa lo que ven los buscadores y los visitantes.
- El navegador arranca solo cuando una regla activa lo necesita; un sitio sin reglas de ese tipo se rastrea por HTTP simple a toda velocidad.
- Los errores de consola, los tiempos de carga y cada recurso que una página carga en tiempo de ejecución se convierten en hechos que las reglas pueden comprobar.
- La accesibilidad se comprueba en la página renderizada frente a WCAG A y AA, así que también se detectan los defectos que introducen los scripts.

<!-- textlint-enable -->
