<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->

[English](../../README.md) · [Español](../es/README.md)

# Spiderlint

Spiderlint обходить кожну сторінку сайту, збирає факти про кожен запит (HTML, заголовки, TLS, таймінги, розміри) і перевіряє їх за наборами правил для груп URL, тож шаблон без заголовка — це один результат, а не по одному на сторінку. Побудовано на Node і Crawlee.

[![Stand with Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://damian-buho.github.io/support-ukraine/) [![Projectfile inside](https://badges.kiota.ch/static/v1?label=projectfile&message=inside&labelColor=0d0d0d&color=8c6723&style=flat-square)](https://projectfile.org) [![License](https://badges.kiota.ch/static/v1?label=license&message=AGPL-3.0-only&color=1e5913&style=flat-square)](LICENSE) [![Cosign](https://badges.kiota.ch/static/v1?label=cosign&message=enabled&color=1e5913&style=flat-square)](https://docs.sigstore.dev/cosign/verifying/verify/) ![ClamAV scanned](https://badges.kiota.ch/static/v1?label=clamav&message=scanned&color=1877aa&style=flat-square) [![PRs welcome](https://badges.kiota.ch/static/v1?label=PRs&message=welcome&color=1e5913&style=flat-square)](CONTRIBUTING.md) [![REUSE compliance](https://api.reuse.software/badge/codeberg.org/damian-buho/spiderlint)](https://api.reuse.software/info/codeberg.org/damian-buho/spiderlint)

![Project status](https://badges.kiota.ch/static/v1?label=status&message=experimental&color=1d63ed&style=flat-square) [![Last commit on kiota.ch](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://kiota.ch&label=last%20commit%20on%20kiota.ch&style=flat-square)](https://kiota.ch/damian-buho/spiderlint) [![Last commit on Codeberg](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://codeberg.org&label=last%20commit%20on%20Codeberg&style=flat-square)](https://codeberg.org/damian-buho/spiderlint) [![Last commit on GitHub](https://badges.kiota.ch/github/last-commit/damian-buho/spiderlint?label=last%20commit%20on%20GitHub&style=flat-square)](https://github.com/damian-buho/spiderlint)

[![Publish pipeline on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/published.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Vulnerability audit on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/audited.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Dependency freshness on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions) [![Analysis sweep on GitHub](https://github.com/damian-buho/spiderlint/actions/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://github.com/damian-buho/spiderlint/actions)

[![Publish pipeline on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/published.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Vulnerability audit on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/audited.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Dependency freshness on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Analysis sweep on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/analyzed.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions)

## Можливості

- Доступність перевіряється з усіх боків
- Сторінки з клієнтським рендерингом перевіряються такими, якими їх бачать відвідувачі
- Усі види сторінок одразу, яким би не був ліміт
- CSS перевірено так, як його читають браузери
- DNS за кожним просканованим хостом
- Стрічки перевіряються так, як їх бачать читачі
- Одна знахідка на шаблон, а не на сторінку
- Іконки завантажено й виміряно
- Вага зображень виміряна, а не оцінена
- Сайт, виміряний цілком
- Мертві посилання на сайті й поза ним
- Автентифікація пошти кожного домену, який він обходить
- Кожне джерело перевіряється один раз, окрім його сторінок
- Структуровані дані й розмітка перевіряються на кожній сторінці
- Проблеми швидкості знаходяться без браузера
- Приватність до згоди
- Сайти в будь-якій мережі, обхід без зайвого навантаження
- Звіти для людей, конвеєрів і агентів програмування
- Залежності сторінок завантажуються один раз
- robots.txt читається так, як його читають краулери
- Понад 500 правил, а нові пишуться як дані
- Видимість у пошуку перевіряється на всьому сайті
- Заголовки безпеки оцінюються, а не лише виявляються
- Сервер перевірок
- Один обхід — багато перевірок
- Слід кожного перегляду сторінки
- Конфігурація TLS, перевірена власними силами
- Транспорт перевіряється для кожної сторінки, а не для хоста
- Те, що додає CDN чи хостинг, окремо
- Файли, які сайт публікує поруч зі своїми сторінками

Також успадковує можливості B19 / Ubuntu — повний перелік див. у [Можливості](FEATURES.md).

## Що надає цей проєкт

- **CI-дія** `damian-buho/spiderlint@0.141.0`
- **Образ контейнера** `ghcr.io/damian-buho/spiderlint:latest`
- **Образ контейнера** `damianbuho/spiderlint:latest`
- `spiderlint` — команда `spiderlint`

## Встановлення

Завантажте опублікований образ контейнера:

### Завантажити з GHCR — linux/amd64

```sh
docker pull ghcr.io/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws ghcr.io/damian-buho/spiderlint:latest spiderlint'
```

### Завантажити з DockerHub — linux/amd64

```sh
docker pull damianbuho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws damianbuho/spiderlint:latest spiderlint'
```

Стабільні випуски також публікують теґи `X.Y.Z`, `X.Y` і `X` — завантажте той рівень точності, який хочете зафіксувати.

Якщо наведені вище реєстри недоступні, завантажте з джерела:

### Завантажити з Kiota — linux/amd64

```sh
docker pull kiota.ch/damian-buho/spiderlint:latest
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws kiota.ch/damian-buho/spiderlint:latest spiderlint'
```

Потім запускайте його так, ніби його встановлено, — псевдонім виконує кожен приклад як написано в поточному каталозі:

```sh
spiderlint --help
```

## Використання

Запускайте його як крок робочого процесу GitHub Actions:

```yaml
- uses: damian-buho/spiderlint@0.141.0
```

Дія приймає такі вхідні параметри:

| Параметр | Типове значення | Опис |
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

Приклади й довідка кожної команди — у [Використання](USAGE.md).

## Збирання

Клонуйте репозиторій разом із підмодулями:

```sh
git clone --recurse-submodules https://codeberg.org/damian-buho/spiderlint spiderlint && cd spiderlint
```

Зберіть образ контейнера локально:

```sh
make container-build
```

- [Довідник із Makefile](../how-to/MAKEFILE.md)

Виконайте `make` без аргументів для типової цілі; виконайте `make help`, щоб переглянути всі цілі.

Для локального циклу розробки `make dev-container` піднімає dev-container.

Точки входу конвеєра:

- `make analyzed` — Запускає важкий аналіз (мутаційне тестування, бенчмарки)
- `make audited` — Повторно сканує закріплені залежності й опубліковані артефакти на нові вразливості
- `make check-outdated` — Звітує про кожну закріплену залежність, що відстає від upstream
- `make ready-to-publish` — Запускає псевдо-CI локально — збирає, тестує й сканує без публікації

## Документація

- [Run spiderlint from a checkout](../how-to/RUN-FROM-A-CHECKOUT.md)

## Політики

- [Як зробити внесок](CONTRIBUTING.md)
- [Політика безпеки](SECURITY.md)
- [Як отримати підтримку](SUPPORT.md)
- [Кодекс поведінки](CODE_OF_CONDUCT.md)
- [Політика щодо ШІ та LLM](AI_POLICY.md)

## Посилання

- [Задачі на GitHub](https://github.com/damian-buho/spiderlint/issues)
- [Специфікація Projectfile](https://projectfile.org)

## Ліцензія

Цей проєкт ліцензовано на умовах AGPL-3.0-only — див. файл [LICENSE](LICENSE) для подробиць.

<!-- textlint-enable -->
