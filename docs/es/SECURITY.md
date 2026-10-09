<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->
[English](../../SECURITY.md) · [Українська](../uk/SECURITY.md)

# Política de seguridad

## Cómo informar de una vulnerabilidad

**No informes de vulnerabilidades de seguridad a través de incidencias, debates o solicitudes de cambio públicos.**

Hazlo escribiendo a **<damian.buho@proton.me>**.

Incluye toda la información que puedas de la siguiente lista; nos ayuda a clasificar y resolver el informe más rápido:

- El tipo de problema (p. ej. desbordamiento de búfer, inyección SQL, cross-site scripting)
- La versión o versiones afectadas
- El impacto del problema, incluido cómo podría explotarlo un atacante
- Instrucciones paso a paso para reproducir el problema
- La ubicación del código fuente afectado (etiqueta, rama, commit o URL directa)
- Las rutas completas de los archivos fuente relacionados con el problema
- Cualquier configuración necesaria para reproducir el problema
- Archivos de registro relevantes, si es posible
- Código de prueba de concepto o de explotación, si es posible

Procuramos acusar recibo de los informes en un plazo de 30 días y coordinar
la divulgación en cuanto exista una corrección.

## Cifrar un informe

Si quieres enviarnos un informe cifrado, sigue estos pasos.

Importa nuestra clave pública:

```sh
gpg --keyserver keys.openpgp.org --recv-keys B64C122EE16C3746
```

Verifica que la huella coincide antes de confiar en ella:

```sh
gpg --fingerprint B64C122EE16C3746
```

La salida debe mostrar:

```text
6F19 7084 3C9E 8406 AD70  0467 B64C 122E E16C 3746
```

Cifra tu mensaje para nosotros:

```sh
gpg --encrypt --armor --recipient B64C122EE16C3746 message.txt
```

## Programa de recompensas

Spiderlint no ofrece actualmente un programa de recompensas. Aun así
agradecemos los informes divulgados de forma responsable — consulta el canal de
contacto anterior.

## Vulnerabilidades reconocidas

Los siguientes hallazgos fueron revisados y se suprimen de forma intencionada
(la corrección depende de una versión posterior del proyecto base o el aviso no
aplica a este proyecto):

| ID | Motivo |
| --- | --- |
| CVE-2026-12151 | bundled undici < 6.27.0 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-vxpw-j846-p89q | bundled undici < 6.27.0 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-13149 | bundled brace-expansion < 5.0.7 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-3jxr-9vmj-r5cp | bundled brace-expansion < 5.0.7 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-14257 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| GHSA-mh99-v99m-4gvg | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-19534 | bundled undici < 6.28.1 in npm (latest dist-tag); no npm release ships the fix |
| GHSA-rfgv-xxqx-mfg5 | bundled undici < 6.28.1 in npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-26996 | bundled minimatch < 10.2.1 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-3ppc-4f35-3m26 | bundled minimatch < 10.2.1 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-27903 | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-7r86-cg39-jmmj | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-27904 | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-23c5-xmqv-rm74 | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-33671 | bundled picomatch < 4.0.4 (npm via tinyglobby, pnpm); fixed upstream, drop after the node fleet rebuilds |
| GHSA-c2c7-rcm5-vvqj | bundled picomatch < 4.0.4 (npm via tinyglobby, pnpm); fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-69152 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| GHSA-rgw5-rvv9-x895 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-69192 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| GHSA-mwp4-54f8-5fhr | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-73566 | bundled tar < 7.5.21 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-r292-9mhp-454m | bundled tar < 7.5.21 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-93687 | bundled braces 3.0.3 in pnpm; no fixed braces release exists |
| GHSA-vfj7-8cjw-p6xm | bundled braces 3.0.3 in pnpm; no fixed braces release exists |
| CVE-2026-93748 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| GHSA-ch52-4w7c-c8xp | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-102276 | bundled brace-expansion < 5.0.10 in npm (latest dist-tag); no npm release ships the fix |
| GHSA-6j4f-fj2g-mc7p | bundled brace-expansion < 5.0.10 in npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-102278 | bundled brace-expansion < 5.0.11 in npm (latest dist-tag); no npm release ships the fix |
| GHSA-qhr7-859c-m2p7 | bundled brace-expansion < 5.0.11 in npm (latest dist-tag); no npm release ships the fix |
| GHSA-528h-pc64-c93x | transitive stream-json dep of a pinned crawlee release; fixable only upstream |
| CVE-2026-71429 | transitive stream-json dep of a pinned crawlee release; fixable only upstream |

<!-- textlint-enable -->
