<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- textlint-disable terminology,common-misspellings -->

# Los archivos que un sitio publica junto a sus páginas

- Se informa de un `security.txt` ausente o caducado, para que quien investiga la seguridad siempre tenga cómo contactarte.
- Un sitio con un campo de contraseña debe llevar `/.well-known/change-password` a algún sitio, para que los gestores de contraseñas lleven al usuario directamente al formulario correcto.
- Cualquier otro archivo conocido (señales de privacidad, metadatos de OpenID y OAuth, enlaces de aplicaciones, información de nodos del Fediverso, condiciones para rastreadores de IA) se comprueba solo si existe, así que publicar uno roto nunca pasa desapercibido.
- Los archivos para agentes de IA (`llms.txt`, tarjetas de agente, índices de MCP y de habilidades) se comprueban en su propio preset opcional, incluidos los enlaces de `llms.txt` que llevan a páginas rotas y si las páginas ofrecen una versión en Markdown.
- Una página inexistente servida como HTML cuenta como ausencia, así que un sitio que responde a cualquier URL no inunda el informe.

<!-- textlint-enable -->
