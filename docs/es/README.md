<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->

[English](../../README.md) · [Українська](../uk/README.md)

# Spiderlint

Spiderlint rastrea cada página que sirve un sitio, recoge datos de cada petición (HTML, cabeceras, TLS, tiempos, tamaños) y los valida contra conjuntos de reglas por grupo de URL, de modo que una plantilla sin encabezado es un solo hallazgo y no uno por página. Construido sobre Node y Crawlee.

[![Stand with Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://damian-buho.github.io/support-ukraine/) [![Projectfile inside](https://badges.kiota.ch/static/v1?label=projectfile&message=inside&labelColor=0d0d0d&color=8c6723&style=flat-square)](https://projectfile.org) [![License](https://badges.kiota.ch/static/v1?label=license&message=AGPL-3.0-only&color=1e5913&style=flat-square)](LICENSE) [![Cosign](https://badges.kiota.ch/static/v1?label=cosign&message=enabled&color=1e5913&style=flat-square)](https://docs.sigstore.dev/cosign/verifying/verify/) ![ClamAV scanned](https://badges.kiota.ch/static/v1?label=clamav&message=scanned&color=1877aa&style=flat-square) [![PRs welcome](https://badges.kiota.ch/static/v1?label=PRs&message=welcome&color=1e5913&style=flat-square)](CONTRIBUTING.md) [![REUSE compliance](https://api.reuse.software/badge/codeberg.org/damian-buho/spiderlint)](https://api.reuse.software/info/codeberg.org/damian-buho/spiderlint)

![Project status](https://badges.kiota.ch/static/v1?label=status&message=experimental&color=1d63ed&style=flat-square) [![Last commit on kiota.ch](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://kiota.ch&label=last%20commit%20on%20kiota.ch&style=flat-square)](https://kiota.ch/damian-buho/spiderlint) [![Last commit on Codeberg](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://codeberg.org&label=last%20commit%20on%20Codeberg&style=flat-square)](https://codeberg.org/damian-buho/spiderlint) [![Last commit on GitHub](https://badges.kiota.ch/github/last-commit/damian-buho/spiderlint?label=last%20commit%20on%20GitHub&style=flat-square)](https://github.com/damian-buho/spiderlint)

[![Publish pipeline on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/published.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Vulnerability audit on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/audited.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Dependency freshness on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Analysis sweep on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions)

[![Publish pipeline on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/published.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Vulnerability audit on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/audited.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Dependency freshness on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Analysis sweep on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions)

## Características

- Accesibilidad revisada desde todos los lados
- Páginas renderizadas en el cliente, auditadas tal como las ven los visitantes
- Todos los tipos de página desde el principio, sea cual sea el límite
- CSS revisado como lo leen los navegadores
- El DNS detrás de cada host rastreado
- Feeds revisados tal como los ven los lectores
- Un hallazgo por plantilla, no por página
- Iconos descargados y medidos
- Peso de imágenes medido, no estimado
- El sitio medido como un todo
- Enlaces rotos, dentro y fuera del sitio
- Autenticación del correo de cada dominio que recorre
- Cada origen comprobado una vez, más allá de sus páginas
- Datos estructurados y marcado revisados en cada página
- Problemas de velocidad encontrados sin navegador
- Privacidad antes del consentimiento
- Sitios en cualquier red, rastreados con cortesía
- Informes para personas, canalizaciones y agentes de código
- Dependencias de página descargadas una sola vez
- robots.txt leído como lo leen los rastreadores
- Más de 500 reglas, y las nuevas escritas como datos
- Visibilidad en buscadores revisada en todo el sitio
- Cabeceras de seguridad evaluadas, no solo detectadas
- Servidor de análisis
- Rastrear una vez, analizar muchas
- La huella de cada visita a una página
- Configuración TLS analizada en casa
- Transporte comprobado por página, no por host
- Lo que añade la CDN o el alojamiento, por separado
- Los archivos que un sitio publica junto a sus páginas

También hereda las características de B19 / Ubuntu; consulta [Características](FEATURES.md) para ver la lista completa.

## Qué entrega este proyecto

- **Acción de CI** `damian-buho/spiderlint@0.141.0`
- **Imagen de contenedor** `ghcr.io/damian-buho/spiderlint:latest`
- **Imagen de contenedor** `damianbuho/spiderlint:latest`
- `spiderlint` — comando `spiderlint`

## Instalación

Descarga la imagen de contenedor publicada:

### Descargar de GHCR — linux/amd64

```sh
docker pull ghcr.io/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws ghcr.io/damian-buho/spiderlint:latest spiderlint'
```

### Descargar de DockerHub — linux/amd64

```sh
docker pull damianbuho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws damianbuho/spiderlint:latest spiderlint'
```

Las versiones estables también publican las etiquetas `X.Y.Z`, `X.Y` y `X`: descarga el nivel de precisión que quieras fijar.

Si los registros anteriores no están disponibles, descarga desde el origen:

### Descargar de Kiota — linux/amd64

```sh
docker pull kiota.ch/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws kiota.ch/damian-buho/spiderlint:latest spiderlint'
```

Después, ejecútalo como si estuviera instalado; el alias ejecuta cada ejemplo tal cual sobre el directorio actual:

```sh
spiderlint --help
```

## Uso

Ejecútalo como un paso de un flujo de trabajo de GitHub Actions:

```yaml
- uses: damian-buho/spiderlint@0.141.0
```

La acción acepta estas entradas:

| Entrada | Valor por defecto | Descripción |
| --- | --- | --- |
| `urls` | | Newline-separated seed URLs. Empty takes the targets from the config file. |
| `config_file` | | Projectfile or plain YAML carrying the org.spiderlint subtree, relative to the workspace. |
| `site` | | One org.spiderlint.sites name to audit; a config declaring several needs one step per site. |
| `rules` | | Comma-separated rulesets replacing every group’s rules (e.g. recommended,axe). |
| `args` | | More audit flags, one per line with its value after a space (e.g. --max-pages 200). |
| `fail_on` | `error` | Severity that fails the job: error \| warning \| info \| never |
| `upload_sarif` | `false` | Upload the SARIF report to code scanning; needs the security-events: write permission. |
| `cache` | `true` | Keep the crawl store in the forge cache, so an unchanged site is re-audited with 304s. |
| `version` | | Image tag to pull (e.g. latest, 1.2.3). Empty follows the action’s own version tag, else latest. |
| `image` | | Full image reference. Takes precedence over `version`. |

### spiderlint

```console
$ spiderlint --help
spiderlint
Site-wide linter for SEO tags, security headers, TLS and links
https://dbuho.me/project/spiderlint/

Usage: spiderlint <command> [domain…] [options]
A domain is example.com or a URL to start from; without a scheme, https:// is
assumed.

Check a site:
  audit [domain…]                 crawl a site, then lint it
  crawl [domain…]                 fetch pages into the store, lint nothing
  lint [domain…]                  lint the stored pages, with no network
  show-report [domain…]           print the stored report again, in any format

Inspect:
  show-facts <url>                fetch one page and print its facts
  export-facts [domain…]          print every stored page’s facts, no network
  list-groups [domain…]           count the pages in each URL group

Rules:
  list-rules [ruleset|id…]        list rules at the severity this config gives
  list-presets                    list the shipped rulesets and their groups
  explain-rule <rule>             show a rule’s facts, expectation and fix

Cache:
  show-cache [domain…]            show the entries, bytes and age of each bucket
  purge-cache [bucket] [domain…]  delete a site’s cached entries
  warm-cache [domain…]            fetch robots.txt and sitemaps without crawling

Commands:
  help [command]                  show a command’s options and examples

Options:
  --config <path>                 settings file
                                  (default: projectfile.yaml)
                                  (env: SPIDERLINT_CONFIG)
  --site <names>                  only these org.spiderlint.sites, repeatable
                                  (default: all)
  --[no-]color                    force or disable color
                                  (default: auto, env: NO_COLOR, FORCE_COLOR)
  --[no-]progress                 status line on an interactive stderr
                                  (default: auto)
  --log-level <level>             trace, debug, info, warn, error or silent
                                  (default: warn, env: SPIDERLINT_LOG_LEVEL)
  -V, --version                   show the version
  -h, --help                      show this screen, or a command’s

Run spiderlint <command> --help for a command’s options and examples.

Exit codes:
  0  clean
  1  findings at or above --fail-on
  2  usage or config error
  3  nothing fetched, or an --offline cache miss
  4  the run failed
```

Los ejemplos y la ayuda de cada comando están en [Uso](USAGE.md).

## Compilación

Clona el repositorio con sus submódulos:

```sh
git clone --recurse-submodules https://codeberg.org/damian-buho/spiderlint spiderlint && cd spiderlint
```

Construye la imagen de contenedor en local:

```sh
make container-build
```

- [Referencia del Makefile](../how-to/MAKEFILE.md)

Ejecuta `make` sin argumentos para el destino predeterminado; ejecuta `make help` para listar todos los destinos.

Para el bucle de desarrollo local, `make dev-container` levanta el dev-container.

Puntos de entrada de la canalización:

- `make analyzed` — Ejecuta el análisis pesado (pruebas de mutación, benchmarks)
- `make audited` — Vuelve a escanear las dependencias fijadas y los artefactos publicados en busca de vulnerabilidades nuevas
- `make check-outdated` — Informa de cada dependencia fijada que va por detrás de su versión upstream
- `make ready-to-publish` — Ejecuta localmente el pipeline pseudo-CI — compila, prueba y escanea, sin publicar

## Documentación

- [Run spiderlint from a checkout](../how-to/RUN-FROM-A-CHECKOUT.md)

## Políticas

- [Cómo contribuir](CONTRIBUTING.md)
- [Política de seguridad](SECURITY.md)
- [Cómo obtener ayuda](SUPPORT.md)
- [Código de conducta](CODE_OF_CONDUCT.md)
- [Política sobre IA y LLM](AI_POLICY.md)

## Enlaces

- [Incidencias en GitHub](https://github.com/damian-buho/spiderlint/issues)
- [Especificación de Projectfile](https://projectfile.org)

## Licencia

Este proyecto se publica bajo la licencia AGPL-3.0-only — consulta el archivo [LICENSE](LICENSE) para más detalles.

<!-- textlint-enable -->
