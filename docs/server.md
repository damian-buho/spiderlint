<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

# Scan server

The image that runs the CLI also runs an HTTP API over a job queue. A client posts
a URL and the settings it would pass on the command line, follows the scan’s
progress, and downloads the report in any format. The instance owner decides,
per domain, what may be scanned, how often and how deeply.

## Modes

`SPIDERLINT_MODE` picks what a container starts:

| Mode     | Starts                                                      |
| -------- | ----------------------------------------------------------- |
| `cli`    | Nothing; the default. `docker run … spiderlint audit <url>` |
| `api`    | The HTTP API only                                           |
| `worker` | Scan workers only                                           |
| `all`    | Both in one process, for a small instance                   |

API and worker share state through Redis or Valkey only, so either side scales
on its own. Each scan runs in its own child process with a wall-clock limit;
a stuck crawl dies with its process.

## Settings file

Runtime settings live in one YAML file, `/etc/spiderlint/server.yaml` by default
(`SPIDERLINT_SERVER_CONFIG` names another). It is read at start and polled every
5 s: a valid edit applies to the next request, an invalid one is logged and the
previous settings stay. `redis`, `listen` and `workers` need a restart. Without the
file, one policy admits every host with the defaults below.

```yaml
redis: redis://:password@valkey:6379/0
listen: { host: 0.0.0.0, port: 8080 }
retention: 7d # jobs and reports are deleted this long after they settle
workers: 2 # scans one worker process runs at a time
max-queued: 100 # a new job is refused with 503 while this many wait
allow-private: false # true lets scans reach loopback and private networks, and allows the browser
defaults: # org.spiderlint keys every scan starts from, under the request’s
  resources: { max-per-page: 50 }
policies: # the first policy whose hosts match the target wins; none matching refuses it
  - name: ru
    hosts: [ru, рф]
    ban: Scans of these hosts are disabled on this instance
  - name: ua
    hosts: [ua]
    rate: { jobs: 1, per: 1h }
  - name: everyone
    hosts: ["*"]
    rate: { jobs: 10, per: 1h }
    caps:
      {
        max-pages: 100,
        max-depth: 5,
        concurrency: 4,
        rate: 120,
        timeout: 30,
        max-body-size: 5000000,
        scan-timeout: 10m,
      }
    fetch: [http]
    rules:
      allow: [recommended, seo, security-headers, tls, links, "http/*"]
      deny: ["lighthouse/*"]
```

A policy entry:

| Key     | Meaning                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `hosts` | Host suffixes: `ua` matches `ua` and every name under it; `*.ua` and `.ua` mean the same. Unicode is accepted (`рф`). `*` is any host. |
| `ban`   | `true`, or the reason the client is shown. The request is refused with `403`.                                                          |
| `rate`  | At most `jobs` scans of one host per `per` window (`45s`, `30m`, `1h`, `7d`). Each host has its own window.                            |
| `caps`  | Upper bounds; a request asking more, or `0` for unlimited, gets the cap. `max-pages` defaults to 100, `scan-timeout` to 10 minutes.    |
| `fetch` | Fetch modes a request may use; the first is the default. `http` only while `allow-private` is false.                                   |
| `rules` | `allow`: rulesets, rule IDs or globs a request may name; absent allows any. `deny`: never run, even inside an allowed ruleset.         |

A request that names no rules runs `recommended`, so an `allow` list without it
refuses such a request. Settings a request may never set: `plugins`, `sources`,
`proxy`, `resolver`, `resolve`, `robots`, `cache`, `profile`, `format`,
`fail-on`, `rulesets`, `sites`, `targets`, `allow-private` and plugin keys. The
owner may still set them under `defaults`.

## API

| Route                               | Answer                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `POST /v1/jobs`                     | `202` and the job, `Location` naming it                                               |
| `GET /v1/jobs/<id>`                 | The job                                                                               |
| `GET /v1/jobs/<id>/events`          | Server-sent events: `progress` on each change, then `done`, `failed` or `expired`     |
| `GET /v1/jobs/<id>/report/<format>` | The report as `json`, `sarif`, `csv`, `checkstyle` or `human`; `409` until it is done |
| `GET /healthz`                      | `status` and the queue’s counts                                                       |

The request body carries the target and, optionally, `org.spiderlint` keys:

```json
{
  "url": "https://example.ua/",
  "settings": {
    "rules": ["seo"],
    "max-pages": 50,
    "groups": { "blog": { "match": ["/blog/**"] } }
  }
}
```

A job:

```json
{
  "id": "0b1e…",
  "url": "https://example.ua/",
  "policy": "ua",
  "status": "running",
  "progress": { "done": 12, "total": 40, "eta": [20, 45] },
  "created": "2026-09-27T09:00:00.000Z",
  "started": "2026-09-27T09:00:01.000Z",
  "links": { "self": "/v1/jobs/0b1e…", "events": "/v1/jobs/0b1e…/events" }
}
```

`status` is `queued`, `running`, `done` or `failed`. `eta` is a range in seconds,
absent until a few pages are timed. A `done` job adds `summary`, as the `json`
report carries it with the rating, and `links.reports`. A `failed` job adds `error`.
The ID is random and unguessable; nothing lists jobs.

A refusal is `{ "error": { "code": "…", "message": "…" } }`. Clients translate the
`code`; the message is for logs:

| Status | Code                                                                   |
| ------ | ---------------------------------------------------------------------- |
| `400`  | `invalid-body`, `invalid-url`, `invalid-settings`, `forbidden-setting` |
| `403`  | `banned`, `no-policy`, `forbidden-rule`, `forbidden-fetch`             |
| `404`  | `not-found`, `unknown-format`                                          |
| `409`  | `not-ready`                                                            |
| `429`  | `rate-limited`, with `Retry-After`                                     |
| `503`  | `queue-full`, with `Retry-After`                                       |

## Address guard

With `allow-private: false` every connection a scan makes resolves through a
guarded lookup and refuses loopback, private, link-local, CGNAT and unique-local
addresses, and an address literal in one of those ranges is refused before a
request is sent. The browser resolves names itself, so it is off. The guard does
not see a redirect `fetch` follows to an address literal, so the scan network
should route to nothing it protects, and Redis should require a password.

## Deployment

```yaml
services:
  valkey:
    image: kiota.ch/o9s/valkey:latest
    environment: { O9S_VLKY_SAVE: "" }
    secrets: [o9s.vlky.password]
  spiderlint-api:
    image: kiota.ch/damian-buho/spiderlint:latest
    environment: { SPIDERLINT_MODE: api }
    volumes: [./server.yaml:/etc/spiderlint/server.yaml:ro]
  spiderlint-worker:
    image: kiota.ch/damian-buho/spiderlint:latest
    environment: { SPIDERLINT_MODE: worker }
    volumes: [./server.yaml:/etc/spiderlint/server.yaml:ro]
```

The health check probes `/healthz` in `api` and `all` modes. A stopped worker
kills its running scans; the queue hands them to another worker once their lock
expires.
