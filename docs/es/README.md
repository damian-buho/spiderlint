<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->

[English](../../README.md) · [Українська](../uk/README.md)

# Spiderlint

Spiderlint rastrea cada página que sirve un sitio, recoge datos de cada petición (HTML, cabeceras, TLS, tiempos, tamaños) y los valida contra conjuntos de reglas por grupo de URL, de modo que una plantilla sin encabezado es un solo hallazgo y no uno por página. Construido sobre Node y Crawlee.

[![Stand with Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://damian-buho.github.io/support-ukraine/) [![Projectfile inside](https://badges.kiota.ch/static/v1?label=projectfile&message=inside&labelColor=0d0d0d&color=8c6723&style=flat-square)](https://projectfile.org) [![License](https://badges.kiota.ch/static/v1?label=license&message=MIT&color=1e5913&style=flat-square)](LICENSE) [![Commit style](https://badges.kiota.ch/static/v1?label=commits&message=conventional%20v1.0.0&color=1877aa&style=flat-square)](https://www.conventionalcommits.org/es/v1.0.0/) ![Workflow](https://badges.kiota.ch/static/v1?label=workflow&message=git-flow&color=1877aa&style=flat-square) [![Versioning](https://badges.kiota.ch/static/v1?label=versioning&message=semantic%20v2.0.0&color=1877aa&style=flat-square)](https://semver.org/lang/es/) [![Citation](https://badges.kiota.ch/static/v1?label=citation&message=cff&color=1877aa&style=flat-square)](CITATION.cff)

![Project status](https://badges.kiota.ch/static/v1?label=status&message=experimental&color=1d63ed&style=flat-square) [![Last commit on kiota.ch](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://kiota.ch&label=last%20commit%20on%20kiota.ch&style=flat-square)](https://kiota.ch/damian-buho/spiderlint)

[![npm version](https://badges.kiota.ch/npm/v/spiderlint?style=flat-square)](https://www.npmjs.com/package/spiderlint) [![npm downloads per month](https://badges.kiota.ch/npm/dm/spiderlint?style=flat-square)](https://www.npmjs.com/package/spiderlint) [![Dependency freshness](https://badges.kiota.ch/librariesio/release/npm/spiderlint?style=flat-square)](https://libraries.io/npm/spiderlint)

[![Publish pipeline on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/published.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Vulnerability audit on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/audited.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Dependency freshness on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Analysis sweep on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/analyze.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions)

## Características

- Accesibilidad revisada desde todos los lados
- Páginas renderizadas en el cliente, auditadas tal como las ven los visitantes
- CSS revisado como lo leen los navegadores
- El DNS detrás de cada host rastreado
- Un hallazgo por plantilla, no por página
- Iconos descargados y medidos
- Peso de imágenes medido, no estimado
- El sitio medido como un todo
- Enlaces rotos, dentro y fuera del sitio
- Autenticación del correo de cada dominio que recorre
- Cada origen comprobado una vez, más allá de sus páginas
- Feeds, datos estructurados y marcado revisados en cada página
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
- Los archivos que un sitio publica junto a sus páginas

También hereda las características de Heredado de B19 / Ubuntu; consulta [FEATURES.md](FEATURES.md) para ver la lista completa.

## Qué entrega este proyecto

- **Imagen de contenedor** `kiota.ch/damian-buho/spiderlint:latest`
- **Paquete npm** `spiderlint` — comando `spiderlint`

## Plataformas admitidas

- `linux/amd64`

## Instalación

### Imagen de contenedor

Descarga la imagen de contenedor publicada:

```sh
docker pull kiota.ch/damian-buho/spiderlint:latest
```

Las versiones estables también publican las etiquetas `X.Y.Z`, `X.Y` y `X`: descarga el nivel de precisión que quieras fijar.

Crea un alias del comando a la imagen para que cada ejemplo funcione tal cual sobre el directorio actual:

```sh
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws kiota.ch/damian-buho/spiderlint:latest spiderlint'
```

Después, ejecútalo como si estuviera instalado:

```sh
spiderlint --help
```

### Paquete npm

Instala el comando de forma global:

```sh
npm install --global spiderlint
```

Requiere Node.js >=26.

## Uso

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
  list-presets                    list shipped rulesets and the groups using
                                  them
  explain-rule <rule>             show what a rule reads and expects, and its
                                  fix

Cache:
  show-cache [domain…]            show the entries, bytes and age of each bucket
  purge-cache [bucket] [domain…]  delete a site’s cached entries
  warm-cache [domain…]            fetch robots.txt and sitemaps without crawling

Commands:
  help [command]                  show a command’s options and examples

Options:
  --config <path>                 settings file (default: projectfile.yaml, env:
                                  SPIDERLINT_CONFIG)
  --site <names>                  only these org.spiderlint.sites, repeatable
                                  (default: all)
  --[no-]color                    force or disable color (default: auto, env:
                                  NO_COLOR, FORCE_COLOR)
  --[no-]progress                 status line on an interactive stderr (default:
                                  auto)
  --log-level <level>             trace, debug, info, warn, error or silent
                                  (default: info, env: SPIDERLINT_LOG_LEVEL)
  -V, --version                   show the version
  -h, --help                      show this screen, or a command’s with the
                                  command

Run spiderlint <command> --help for a command’s options and examples.

Exit codes:
  0  clean
  1  findings at or above --fail-on
  2  usage or config error
  3  nothing fetched, or an --offline cache miss
  4  the run failed
```

Los ejemplos y la ayuda de cada comando están en [USAGE.md](USAGE.md).

## Compilación

Construye la imagen de contenedor en local:

```sh
make container-build
```

- [Referencia del Makefile](../how-to/MAKEFILE.md)

Ejecuta `make` sin argumentos para el destino predeterminado; ejecuta `make help` para listar todos los destinos.

Para el bucle de desarrollo local, `make dev-container` levanta el dev-container.

Puntos de entrada de la canalización:

- `make analyze` — Ejecuta el análisis pesado (pruebas de mutación, benchmarks)
- `make audited` — Vuelve a escanear las dependencias fijadas y los artefactos publicados en busca de vulnerabilidades nuevas
- `make check-outdated` — Informa de cada dependencia fijada que va por detrás de su versión upstream
- `make ready-to-publish` — Ejecuta localmente el pipeline pseudo-CI — compila, prueba y escanea, sin publicar

## Políticas

- [Cómo contribuir](CONTRIBUTING.md)
- [Política de seguridad](SECURITY.md)
- [Cómo obtener ayuda](SUPPORT.md)
- [Código de conducta](CODE_OF_CONDUCT.md)
- [Política sobre IA y LLM](AI_POLICY.md)

## Enlaces

- [Especificación de Projectfile](https://projectfile.org)

## Licencia

Este proyecto se publica bajo la licencia MIT — consulta el archivo [LICENSE](LICENSE) para más detalles.

<!-- textlint-enable -->
