<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->

[English](../../README.md) · [Español](../es/README.md)

# Spiderlint

Spiderlint обходить кожну сторінку сайту, збирає факти про кожен запит (HTML, заголовки, TLS, таймінги, розміри) і перевіряє їх за наборами правил для груп URL, тож шаблон без заголовка — це один результат, а не по одному на сторінку. Побудовано на Node і Crawlee.

[![Stand with Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg)](https://damian-buho.github.io/support-ukraine/) [![Projectfile inside](https://badges.kiota.ch/static/v1?label=projectfile&message=inside&labelColor=0d0d0d&color=8c6723&style=flat-square)](https://projectfile.org) [![License](https://badges.kiota.ch/static/v1?label=license&message=MIT&color=1e5913&style=flat-square)](LICENSE) [![Commit style](https://badges.kiota.ch/static/v1?label=commits&message=conventional%20v1.0.0&color=1877aa&style=flat-square)](https://www.conventionalcommits.org/uk/v1.0.0/) ![Workflow](https://badges.kiota.ch/static/v1?label=workflow&message=git-flow&color=1877aa&style=flat-square) [![Versioning](https://badges.kiota.ch/static/v1?label=versioning&message=semantic%20v2.0.0&color=1877aa&style=flat-square)](https://semver.org/lang/uk/) [![Citation](https://badges.kiota.ch/static/v1?label=citation&message=cff&color=1877aa&style=flat-square)](CITATION.cff)

![Project status](https://badges.kiota.ch/static/v1?label=status&message=experimental&color=1d63ed&style=flat-square) [![Last commit on kiota.ch](https://badges.kiota.ch/gitea/last-commit/damian-buho/spiderlint?gitea_url=https://kiota.ch&label=last%20commit%20on%20kiota.ch&style=flat-square)](https://kiota.ch/damian-buho/spiderlint)

[![npm version](https://badges.kiota.ch/npm/v/spiderlint?style=flat-square)](https://www.npmjs.com/package/spiderlint) [![npm downloads per month](https://badges.kiota.ch/npm/dm/spiderlint?style=flat-square)](https://www.npmjs.com/package/spiderlint) [![Dependency freshness](https://badges.kiota.ch/librariesio/release/npm/spiderlint?style=flat-square)](https://libraries.io/npm/spiderlint)

[![Publish pipeline on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/published.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Vulnerability audit on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/audited.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Dependency freshness on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/check-outdated.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions) [![Analysis sweep on kiota.ch](https://kiota.ch/damian-buho/spiderlint/badges/workflows/analyze.yaml/badge.svg?style=flat-square)](https://kiota.ch/damian-buho/spiderlint/actions)

## Можливості

- Доступність перевіряється з усіх боків
- Сторінки з клієнтським рендерингом перевіряються такими, якими їх бачать відвідувачі
- CSS перевірено так, як його читають браузери
- DNS за кожним просканованим хостом
- Одна знахідка на шаблон, а не на сторінку
- Іконки завантажено й виміряно
- Вага зображень виміряна, а не оцінена
- Сайт, виміряний цілком
- Мертві посилання на сайті й поза ним
- Автентифікація пошти кожного домену, який він обходить
- Кожне джерело перевіряється один раз, окрім його сторінок
- Стрічки, структуровані дані й розмітка перевіряються на кожній сторінці
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
- Файли, які сайт публікує поруч зі своїми сторінками

Також успадковує можливості Успадковано від B19 / Ubuntu — повний перелік див. у [FEATURES.md](FEATURES.md).

## Що надає цей проєкт

- **Образ контейнера** `kiota.ch/damian-buho/spiderlint:latest`
- **Пакунок npm** `spiderlint` — команда `spiderlint`

## Підтримувані платформи

- `linux/amd64`

## Встановлення

### Образ контейнера

Завантажте опублікований образ контейнера:

```sh
docker pull kiota.ch/damian-buho/spiderlint:latest
```

Стабільні випуски також публікують теґи `X.Y.Z`, `X.Y` і `X` — завантажте той рівень точності, який хочете зафіксувати.

Створіть псевдонім команди на образ, щоб кожен приклад працював як написано в поточному каталозі:

```sh
alias spiderlint='docker run --rm --user "$(id -u):$(id -g)" --group-add 0 --volume "$PWD:/app/ws" --workdir /app/ws kiota.ch/damian-buho/spiderlint:latest spiderlint'
```

Потім запускайте його так, ніби його встановлено:

```sh
spiderlint --help
```

### Пакунок npm

Встановіть команду глобально:

```sh
npm install --global spiderlint
```

Потребує Node.js >=26.

## Використання

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

Приклади й довідка кожної команди — у [USAGE.md](USAGE.md).

## Збирання

Зберіть образ контейнера локально:

```sh
make container-build
```

- [Довідник із Makefile](../how-to/MAKEFILE.md)

Виконайте `make` без аргументів для типової цілі; виконайте `make help`, щоб переглянути всі цілі.

Для локального циклу розробки `make dev-container` піднімає dev-container.

Точки входу конвеєра:

- `make analyze` — Запускає важкий аналіз (мутаційне тестування, бенчмарки)
- `make audited` — Повторно сканує закріплені залежності й опубліковані артефакти на нові вразливості
- `make check-outdated` — Звітує про кожну закріплену залежність, що відстає від upstream
- `make ready-to-publish` — Запускає псевдо-CI локально — збирає, тестує й сканує без публікації

## Політики

- [Як зробити внесок](CONTRIBUTING.md)
- [Політика безпеки](SECURITY.md)
- [Як отримати підтримку](SUPPORT.md)
- [Кодекс поведінки](CODE_OF_CONDUCT.md)
- [Політика щодо ШІ та LLM](AI_POLICY.md)

## Посилання

- [Специфікація Projectfile](https://projectfile.org)

## Ліцензія

Цей проєкт ліцензовано на умовах MIT — див. файл [LICENSE](LICENSE) для подробиць.

<!-- textlint-enable -->
