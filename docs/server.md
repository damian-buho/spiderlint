<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

# Scan server

The image that runs the CLI also runs an HTTP API over a job queue, and a small
site over the same API. A client posts a URL and the settings it would pass on
the command line, follows the scan’s progress, and downloads the report in any
format; a person types a domain into a form and reads the report as a page. The instance owner decides,
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
previous settings stay. `redis`, `redis-password-file`, `listen`, `workers` and `clock-references` need a restart. Without the
file, one policy admits every host with the defaults below.

```yaml
redis: redis://valkey:6379/0
redis-password-file: /run/secrets/o9s.vlky.password # the password, kept out of this file
listen: { host: 0.0.0.0, port: 8080 }
retention: 7d # jobs and reports are deleted this long after they settle
workers: 2 # scans one worker process runs at a time
max-queued: 100 # a new job is refused with 503 while this many wait
allow-private: false # true lets scans reach loopback and private networks, and allows the browser
clock-references: [https://www.cloudflare.com/, https://www.google.com/, https://www.wikipedia.org/] # our clock is checked against their Date at start; [] skips it
defaults: # org.spiderlint keys every scan starts from, under the request’s
  resources: { max-per-page: 50 }
page:
  directory: /etc/spiderlint/page # head.html, header.html and footer.html, each also as <slot>.<lang>.html
  assets: /etc/spiderlint/assets # served as they are under /assets/
analytics:
  matomo: { url: https://mtm.example/, site-id: 3, site: https://scan.example/, privacy: https://scan.example/privacy } # page views reported by the server
clients:
  rate: { jobs: 10, per: 1h } # scans one client address may queue; false for no limit
  trusted-proxies: [172.18.0.0/16] # peers whose X-Forwarded-For names the client
  trust-providers: [cloudflare] # CDN edges trusted the same way: cloudflare, akamai, fastly
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
    repeat: 30m
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

| Key      | Meaning                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosts`  | Host suffixes: `ua` matches `ua` and every name under it; `*.ua` and `.ua` mean the same. Unicode is accepted (`рф`). `*` is any host.                      |
| `ban`    | `true`, or the reason the client is shown. The request is refused with `403`.                                                                               |
| `rate`   | At most `jobs` scans of one host per `per` window (`45s`, `30m`, `1h`, `7d`). Each host has its own window.                                                 |
| `repeat` | A request for the same URL with the same settings inside this window gets the job already queued, running or done, with `200`. Unset: every request queues. |
| `caps`   | Upper bounds; a request asking more, or `0` for unlimited, gets the cap. `max-pages` defaults to 100, `scan-timeout` to 10 minutes.                         |
| `fetch`  | Fetch modes a request may use; the first is the default. `http` only while `allow-private` is false.                                                        |
| `rules`  | `allow`: rulesets, rule IDs or globs a request may name; absent allows any. `deny`: never run, even inside an allowed ruleset.                              |

The form offers three rule sets as radios, `recommended` first: `recommended`
(Standard), `web-quick` and `web-comprehensive`. `web-quick` runs search tags,
security headers, caching, TLS, redirects, `robots.txt` and internal links over
HTTP, on at most 25 pages and without fetching resources or probing external
links. `web-comprehensive` is `recommended` plus the link graph, language,
structured data, manifest, markup, link text, well-known files, trackers,
footprint and vendor paths. Neither needs a browser or reaches what the server
never serves. A choice is an ordinary request naming that rule set, so `rules.allow`
and `rules.deny` decide it per host: an option no policy admits is not shown, and
one the host’s own policy refuses answers the form with “A requested rule is not
available”. List `web-*` in `allow` to offer them where `allow` is set. A preset
lowers `max-pages` and never raises a cap past the policy’s. The job page and the
report header name the rule set.

A request that names no rules runs `recommended`, so an `allow` list without it
refuses such a request. Settings a request may never set: `plugins`, `sources`,
`proxy`, `resolver`, `resolve`, `robots`, `cache`, `profile`, `format`,
`fail-on`, `role`, `rulesets`, `sites`, `targets`, `allow-private`, `browser-install` and plugin keys. The
owner may still set them under `defaults`, except `browser-install`: scans never
download a browser, so it stays off and a scan needing one fails naming the install.

## Clients

`clients.rate` is a token bucket per client address over job submissions, from
the API and the form alike: `jobs` at once, refilled evenly over `per`. It
defaults to 10 an hour. The address is the peer’s, or, while the peer is in
`trusted-proxies`, the `X-Forwarded-For` entry it added, read right to left.
Behind a CDN, `trust-providers` adds its edge ranges to that walk; they are
fetched from the provider when the API starts and every day, and a provider
whose fetch fails is skipped with a warning, so its edges count as clients until
the next fetch.
Addresses live in the API process’s memory only, never in Redis, so each
API replica keeps its own buckets.

Every request is logged with `client`, the same address, so the log shows who
asked for what; keep the log’s retention to what that needs.

## API

| Route                               | Answer                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /v1/jobs`                     | `202` and the job, `Location` naming it                                                       |
| `GET /v1/jobs/<id>`                 | The job                                                                                       |
| `GET /v1/jobs/<id>/events`          | Server-sent events: `progress` on each change, then `done`, `failed` or `expired`             |
| `GET /v1/jobs/<id>/report/<format>` | The report as `json`, `sarif`, `csv`, `checkstyle`, `human` or `html`; `409` until it is done |
| `GET /healthz`                      | `status` and the queue’s counts                                                               |

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
  "links": {
    "self": "/v1/jobs/0b1e…",
    "page": "/jobs/0b1e…",
    "events": "/v1/jobs/0b1e…/events"
  }
}
```

`status` is `queued`, `running`, `done` or `failed`. `eta` is a range in seconds,
absent until a few pages are timed. A `done` job adds `summary`, as the `json`
report carries it with the rating, and `links.reports`. A `failed` job adds `error`.
The ID is random and unguessable; nothing lists jobs.

A refusal is `{ "error": { "code": "…", "message": "…" } }`. Clients translate the
`code`; the message is for logs:

| Status | Code                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| `400`  | `invalid-body`, `invalid-url`, `invalid-settings`, `forbidden-setting`, `unknown-rule` |
| `403`  | `banned`, `no-policy`, `forbidden-rule`, `forbidden-fetch`                             |
| `404`  | `not-found`, `unknown-format`                                                          |
| `409`  | `not-ready`                                                                            |
| `429`  | `rate-limited` (the host’s window), `client-rate-limited`, with `Retry-After`          |
| `503`  | `queue-full`, with `Retry-After`                                                       |

`unknown-rule` names a ruleset or rule ID that no configured plugin defines; it is
checked before any window is charged.

## Pages

| Route                   | Page                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `GET /`                 | A form taking a domain (`https://` is assumed) or a URL                                  |
| `POST /`                | Queues the scan and redirects to its page with `303`, or shows the form with the refusal |
| `GET /jobs/<id>`        | Progress while queued or running, then the report, its downloads and the badge           |
| `GET /badge/<host>.svg` | The grade of the host’s latest finished scan, linking to it; `not scanned` otherwise     |

Pages are rendered on the server and work without JavaScript: a waiting page
refreshes itself every 5 s, and with scripts it follows the job’s events instead.
The language comes from `Accept-Language` (`en`, `es`, `uk`, English otherwise),
with `lang` and `dir` set; finding messages and rule IDs stay as the report
carries them. A form sent from another site (`Sec-Fetch-Site: cross-site`) is
refused. Every page carries a content security policy allowing only its own
style sheet and script by hash.

A finished host is the badge’s for `retention`, so its latest report is public to
anyone who knows the hostname.

## Customising pages

An instance owner adds to the form and job pages from the settings file, with no
change to the image. Both keys under `page` are read at start and again whenever the
settings change; a fragment edited on disk is picked up within 5 s, and an invalid
edit is logged and the last good fragments stay. The badge and the API are never
touched.

- `page.directory` holds up to three HTML fragments: `head.html` goes into the
  `<head>`, `header.html` above the page and `footer.html` below it. A fragment
  named `<slot>.<lang>.html` (`footer.uk.html`) wins for readers of that language,
  the language `Accept-Language` picks; the plain file is the fallback. `{lang}`
  and `{dir}` inside a fragment become the language code and `ltr` or `rtl`, and
  nothing else is substituted.
- `page.assets` is a directory served under `/assets/` with the type its
  extension names. There is no listing, no dotfile and nothing outside the
  directory, so an owner can host a script or an image on the server’s own origin.

The content security policy stays automatic. When a fragment loads, every inline
`<script>` and `<style>` in it is hashed, per language since `{lang}` changes the
text, and joins that response’s policy. An external `<script src>` or
`<link rel="stylesheet">` must carry `integrity` and be `https:` or a path on the
server, or the settings are refused naming the file; its origin joins the policy.
While `page.assets` is set, `'self'` joins `script-src` and `style-src` too, so a
fragment can import a module it hosts. Inline event handlers and `style=""`
attributes stay blocked, and the pages work without JavaScript.

`analytics.matomo` reports each form and job page view to a Matomo from the
server, through its HTTP tracking API: no script reaches the browser, the policy
does not change and visits without JavaScript count. Only the page name, its route,
the language and the user agent are sent, never the client address. The badge,
`/assets/` and `/v1/` are not reported, nor a visitor who sends `DNT: 1` or
`Sec-GPC: 1`. A job page is tracked as `/jobs/:id` titled “Scan report”, with the
scanned host in the title only under `include-hosts: true`. Every page links
`privacy` while it is on. Each report waits at most 3 s and never delays the page;
after a failure reporting pauses, a minute longer for each failure in a row, up to
ten.

Worked example, a banner module hosted on the server: copy its per-locale files into
`page.assets`, then one `head.html` loads the one for the reader’s language.

```html
<script type="module">import "/assets/banner/{lang}.js";</script>
```

Worked example, Matomo: no fragment, only the block under `analytics` shown in the
settings file above. A browser tracker would instead be a `head.html` with its
`<script src="https://matomo.example/matomo.js" integrity="…">`, which also needs
the `connect-src` and `img-src` a tracker uses and so is not supported.

Each load logs which fragments, assets and Matomo are active and how many hashes
were added to the policy.

## Address guard

With `allow-private: false` every connection a scan makes resolves through a
guarded lookup and refuses loopback, private, link-local, CGNAT and unique-local
addresses, and an address literal in one of those ranges is refused before a
request is sent, on every redirect hop too. The browser resolves names itself,
so it is off. Keep the scan network routed to nothing it protects anyway, and
Redis behind a password.

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
    secrets: [o9s.vlky.password]
    volumes: [./server.yaml:/etc/spiderlint/server.yaml:ro]
  spiderlint-worker:
    image: kiota.ch/damian-buho/spiderlint:latest
    environment: { SPIDERLINT_MODE: worker }
    secrets: [o9s.vlky.password]
    volumes: [./server.yaml:/etc/spiderlint/server.yaml:ro]
```

The health check probes `/healthz` in `api` and `all` modes. A stopped worker
kills its running scans; the queue hands them to another worker once their lock
expires.

## Telemetry

Traces, metrics and logs go to an OpenTelemetry collector over OTLP/HTTP once
any of these variables names an endpoint. Unset, the SDK and its exporters are
never loaded, and stderr output is the same either way.

| Variable                                                                                                        | Effect                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                   | Base URL of the collector, `http://collector:4318`; switches telemetry on                  |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | One signal’s full URL; any one also switches telemetry on                                  |
| `OTEL_SERVICE_NAME`                                                                                             | `service.name` of every signal, `spiderlint` when unset                                    |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                                                                   | `http/json` for traces and metrics; the log transport also takes `http/protobuf` or `grpc` |
| `OTEL_METRIC_EXPORT_INTERVAL`                                                                                   | Milliseconds between metric exports, 15000 by default                                      |
| `OTEL_SDK_DISABLED`                                                                                             | `true` keeps everything off whatever the endpoints say                                     |

What each signal carries:

- Traces: one span per API request (`GET /v1/jobs/:id`), continuing a
  `traceparent` the caller sends; `scan job` in the worker, continuing the
  request that queued it through the job’s data; `scan` in the runner child,
  continuing the job through its stdin; under it one `page` span per crawled page
  and one `extract <id>` span per extractor run. The CLI traces a run the same
  way, as `spiderlint <command>`.
- Metrics: `spiderlint.http.requests` (route, method, status),
  `spiderlint.refusals` (by `code`, rate windows and client buckets included),
  `spiderlint.queue.depth` (by state), `spiderlint.scan.duration` (seconds, by
  outcome), `spiderlint.scan.pages` and `spiderlint.extractor.duration`
  (milliseconds, by extractor).
- Logs: every `pino` record, with the `trace_id` and `span_id` of the span it was
  written in, through `pino-opentelemetry-transport`.
