<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

# damian-buho/spiderlint

Site-wide linter. Crawls every page a site serves, collects facts about each
request (HTML, headers, TLS, timings, sizes), and lints those facts against
rulesets scoped by URL group. One template with a missing `<h1>` is one
finding, not a finding per page.

Status: v1 in progress. Implemented: http and browser crawl with link
discovery, scope, depth, glob and body-size limits; `auto` fetch derived per
run (browser when any group pins it or any enabled rule reads `browser.*`); sitemap discovery and facts; transport,
TLS and resource facts; groups; declarative and built-in rules, presets
`seo`, `security-headers`, `links`, `tls`, `cookies`, `redirects`, `sitemap`,
`resources`, `browser`, `recommended`, `all`; site-wide `unique`; folding; `human`, `json`,
`sarif`; `pf-cli` and plain-file config; the store with `crawl`, `lint`,
`report` and `--resume`; the `pages`, `resources`, `sitemaps` and `robots`
buckets with RFC 9111 revalidation, `cache status|purge|warm`, `--no-cache`,
`--refresh` and `--offline`; `rules` and `presets`; plugins with extractors, rules and presets, browser-mode
extractors, the bundled `html-validate` and `axe`; the fixture site. Not yet: adaptive fetch and a
fetch mode per group, the `probes` bucket, `Crawl-delay`, `explain`, plugin formatters and sources, `lighthouse`, localised
messages, `links/broken-external`, the `i18n` preset, `checkstyle` and `csv`.
The rest of this document is the specification the remaining parts are built from.
Sections marked *v1* are in scope for the first release; *later* rows are
recorded so the v1 shape does not block them.

## Key facts

- Base: `b19/node-26`, TypeScript run directly by Node (`--experimental-strip-types`), no build step — same as [textlint-server](../textlint-server/AGENTS.md)
- Crawler: [Crawlee](https://crawlee.dev/js/docs/quick-start) 3.18 — `HttpCrawler` (cheerio) by default, `PlaywrightCrawler` on demand, `AdaptivePlaywrightCrawler` to decide per page
- Image: `damian-buho/spiderlint` with the Chromium headless shell baked in (`PLAYWRIGHT_BROWSERS_PATH`, as [d9t/mcphub](../../d9t/mcphub/AGENTS.md) does); amd64 only, because `b19/node` is
- Config: the `org.spiderlint` projectfile subtree, read through `pf-cli get -f document org.spiderlint` — never parsed by spiderlint itself, exactly as [ignorelint](../ignorelint/docs/cli.md#configuration) reads `org.ignorelint`
- Output: `human` (default), `json`, `sarif`, `checkstyle`, `csv` — same names ignorelint uses
- Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` bad arguments or config, `3` no seed could be fetched, `4` the run failed after it started
- License: MIT. Enrolled in `mani.yaml`; published to kiota, mirrored to GitHub and Codeberg like every `damian-buho/` project

## Scope

In scope: anything that can be asserted about a page from its own response and
from the set of pages around it. SEO tags, security headers, TLS, redirect
chains, link integrity, sitemap consistency, page weight, timings.

Out of scope: fixing anything, authenticated crawling beyond a static header or
cookie, JavaScript execution beyond what Playwright renders, anything that
needs a second crawl at a later date (that is a `--baseline` diff, *later*).

Existing tools it overlaps with, and why they are not enough: paid SEO crawlers
(closed, per-seat), `unlighthouse` (Lighthouse only), `linkinator` (links
only), `html-validate` (one document at a time), securityheaders.com (front
page only). spiderlint is the crawl those tools are missing, and hosts them as
plugins over one page cache.

## Concepts

| Term      | Meaning                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Target    | A seed URL, from the command line or `org.spiderlint.targets`. With neither, the command prints its usage.                        |
| Page      | One fetched URL: request, response, body, and everything derived from them.                                                       |
| Facts     | The JSON document extractors build for a page. Rules read facts and nothing else.                                                 |
| Extractor | Code that turns a page into facts. Static (needs the body) or live (needs the open browser page). Cheap or expensive.             |
| Resource  | A sub-request a page depends on: script, style, image, font, iframe, preload. Any origin. Fetched and linted, never crawled.      |
| Group     | A named set of pages, matched by URL glob or regular expression. A page is in exactly one group. A group approximates a template. |
| Ruleset   | A named map of rules, extendable. Presets ship as rulesets.                                                                       |
| Rule      | `fact` + `expect` (JSON Schema) + `severity`, or a TypeScript function. Scoped `page`, `group`, or `site`.                        |
| Finding   | One violation: rule, severity, page (or group), message, the offending value.                                                     |
| Fold      | Collapsing per-page findings of one rule in one group into one template-level finding.                                            |
| Store     | The on-disk page cache: facts, bodies, crawl frontier. Crawlee’s own storage, nothing custom.                                     |
| Formatter | Findings to text. A plugin kind.                                                                                                  |
| Source    | Where URLs come from: seeds, sitemap, discovered links. A plugin kind.                                                            |
| Plugin    | An ESM module exporting any of `extractors`, `rules`, `formatters`, `sources`, `presets`.                                         |

## Pipeline

```text
seeds ─┐
sitemap┼─► frontier ─► fetch ─► extract ─► store ─► assign group ─► lint (page) ─┐
links ─┘   (robots)   (http|browser)  (facts)        (first match)                 │
                                                                                   ▼
                                                     lint (group, site) ─► fold ─► format ─► exit code
```

- **accumulate** (default): keep facts and bodies in the site’s store. `spiderlint lint <url>` re-runs rules with no network; `spiderlint report <url>` re-formats.
- **stream** (`--no-cache`): lint each page as its facts land; keep facts, drop the body; fold and format at the end, writing nothing. Memory is bounded by findings, not pages.
- One pipeline, two store adapters. The linter subscribes to the store’s `page` event in both modes; only what the store retains differs.
- `--fail-fast` exits on the first `error` finding and skips folding.

## Discovery

- Seeds: CLI URLs, then projectfile `links`, then `spiderlint.targets`.
- Sitemap: `robots.txt` `Sitemap:` lines plus `/sitemap.xml`, `/sitemap.txt` and `/sitemap_index.xml` when no seed names a sitemap. spiderlint fetches every file and every same-host file an index names itself, gunzips by magic bytes, and hands the text to Crawlee’s parser; each file becomes a `site.sitemaps` entry. Union with discovered links. The difference is itself lint input: `sitemap/orphan` (listed, never linked) and `sitemap/unlisted` (linked, never listed); a file that does not fetch, does not parse or names no URL is `sitemap/unreadable`.
- Robots: spiderlint reads `robots.txt` through the `robots` bucket and hands it to Crawlee’s `respectRobotsTxtFile` — disallowed URLs are skipped and logged through `onSkippedRequest`; a `4xx` allows everything and a `5xx` or no answer disallows everything (RFC 9309 §2.3.1); `Crawl-delay` maps to `sameDomainDelaySecs`. `--no-robots` prints a warning and is intended for staging hosts.
- Scope: `origin` (default), `host` (any port and scheme), `domain` (subdomains). Scope governs what is CRAWLED — which pages are fetched and parsed for more links.
- Off-scope LINKS (`<a href>`) are recorded as facts and probed with `HEAD` by `links/*` rules for existence only.
- RESOURCES are different: a script, style sheet, image, font or iframe a page loads is our dependency whatever its origin. A CDN script with a bad `Cache-Control`, no `integrity`, or an expiring certificate is our finding. Resources are fetched with `GET` once per URL (see the `resources` bucket), never parsed for links, and their facts hang off the page that loads them.
- Limits: `--max-pages` (`maxRequestsPerCrawl`), `--max-depth` (`maxCrawlDepth`), `--include` / `--exclude` globs applied before enqueue.
- Bodies: HTML, XML and JSON are read up to `--max-body-size` (10 MB); any other type is judged by its headers and its download aborted once they arrive — one round trip, where `HEAD` then `GET` would cost two. `http.size.truncated` marks both.
- `rel=nofollow` and `<meta name=robots content=nofollow>` are facts, not crawl barriers — the owner audits their own site.

## Fetch

| Mode       | Crawlee class               | When                                                                              |
| ---------- | --------------------------- | --------------------------------------------------------------------------------- |
| `http`     | `HttpCrawler` + cheerio     | Default. 10–50× cheaper than a browser.                                           |
| `browser`  | `PlaywrightCrawler`         | SPAs, pages whose meta tags are rendered client-side.                             |
| `adaptive` | `AdaptivePlaywrightCrawler` | Unknown sites: samples `renderingTypeDetectionRatio` pages and switches per page. |

The mode is DERIVED per group, never guessed. Every fact path belongs to an
extractor, and every extractor declares the mode it needs (`html.*` and
`http.*` are `http`; `browser.*`, `lighthouse.*`, `axe.*` are `browser`).
A group’s mode is the highest mode any of its enabled rules reads — one rule
on `browser.console.errors` upgrades its whole group, and since a page is
fetched once, upgrading the group is exactly upgrading the job for those
pages. `spiderlint groups` prints the derived mode and the rule that forced it.

`fetch` values: `auto` (default — derived as above; a group nothing forces
runs `adaptive`, so a site that renders its meta tags client-side never
costs a second run), `http` (pin; a browser-only rule is then a config error,
exit `2`, unless it is `off`), `browser` (force everything), `adaptive`
(Crawlee decides per page everywhere nothing forces `browser`).
Overridable per group (`groups.app.fetch: browser`) for sites whose meta tags
are rendered client-side — a site property no rule can declare.

`browser` picks the Playwright engine (`--browser`, `SPIDERLINT_BROWSER`). The image ships Chromium only; `firefox` and `webkit` run where Playwright has them installed, and one that is missing is a config error naming `npx playwright install <name>`.

The browser also yields facts HTTP cannot: console errors, Navigation Timing,
and the COMPLETE resource census — including what JavaScript loads at
runtime, which the http mode’s static parse of `src`/`href`/`srcset` cannot see.
The `resources` extractor runs in both modes; browser mode marks each entry
`observed: true` and adds the ones only the network log knows — a request the
browser blocked (ORB, CSP) or that failed counts as observed.

Browser mode reads less of the connection than http mode: no `http.version`,
and `tls` carries protocol, subject, issuer and validity but no cipher, ALPN,
fingerprint or SAN. It never sends conditional requests; a stored page is
re-rendered. A navigation Chromium turns into a download becomes a page judged
by its headers, as http mode judges any unparsed type.

Crawlee’s session pool retires a session on `401`, `403` and `429` and retries
the request until it fails, so such a page would vanish from the facts. Both
crawlers set `blockedStatusCodes: []`: those statuses are findings, not blocks.

Captured for every page regardless of mode: status, HTTP version, redirect
chain, all headers, remote address, `got` timings (`dns`, `tcp`, `tls`,
`ttfb`, `download`, `total`), raw and decoded body size, content encoding, charset.

TLS facts are PER PAGE, read from the connection that served that response:
the `TLSSocket` behind the `IncomingMessage` in http mode
(`getPeerCertificate`, `getProtocol`, `getCipher`, `alpnProtocol`,
`authorizationError`), `response.securityDetails()` and `serverAddr()` in
browser mode. One name can front two backends — a CDN edge for `/blog/*`, an
origin for `/app/*`, each with its own certificate, protocol and address — and
a once-per-host probe would hide that. With keep-alive, pages sharing a
connection share the same observation; `--no-keepalive` forces a fresh
handshake per page for a complete census at the cost of speed.

## Facts document

The single contract between extractors and rules. Dump it for any page with
`spiderlint facts <url>`; writing a rule is reading this JSON and writing a
schema against it.

```yaml
url:      { href, origin, protocol, host, pathname, search }
group:    posts
crawl:    { depth, discoveredVia: seed|sitemap|link, referrers: [], inDegree, requested }
robots:   { allowed, xRobotsTag }
sitemap:  { listed, lastmod, changefreq, priority }
http:     { status, version, redirects: [{ url }],
            headers: { name: value | [value] }, remote: { address, family },
            timing: { dns, tcp, tls, ttfb, download, total },
            size: { body, decoded, declared, truncated }, contentType, charset,
            cookies: [{ name, secure, httpOnly, sameSite }] }
tls:      { protocol, cipher, alpn, authorized, error,          # from this page’s connection
            cert: { subject, issuer, notBefore, notAfter, daysLeft, san: [], fingerprint256 } }
html:     { lang, title, h1: [], h2: [], canonical, robots,
            meta: { name: content }, property: { og:title: … },
            links: { internal: [], external: [], nofollow: [] },
            images: [{ src, alt }], hreflang: [{ lang, href }],
            jsonld: [], wordCount, generator }
resources: [{ url, kind: script|style|image|font|iframe|preload, origin: same|cross,
              integrity, crossorigin, observed,                 # from the HTML, or the network log
              http: { status, headers, timing, size, contentType }, tls: { … } }]
browser:  { timing: { domContentLoaded, load }, console: { errors: [], warnings: [] },
            weight: { script, style, image, font } }
```

Facts about the site rather than one page form a second document, handed to
group and site rules beside the pages:

```yaml
site:     { sitemaps: [{ url, status, urls, sitemaps, error }] }
```

Plugins add their own top-level key (`lighthouse`, `axe`, `htmlvalidate`).
Header names are lower-cased; repeated headers become arrays. Absent is
absent, never `null`, so `{ type: string }` doubles as an existence check.

## Groups

```yaml
groups:
  posts:
    match: ["/posts/**", "/blog/**"]
    rules: [seo, security-headers]
  tags:
    match: ["/tags", "re:^/tag/[^/]+$"]
    rules: [security-headers]          # no SEO expectations on tag indexes
  app:
    match: ["/app/**"]
    fetch: browser
    rules: [security-headers]
  default:                             # implicit catch-all when omitted
    rules: [recommended]
```

- Ordered, first match wins, `default` last. Exactly one group per page — a group stands in for a template, and folding depends on that. A group without `rules` runs `recommended`; `rules: []` runs nothing. A top-level `rules` (`--rules`, `SPIDERLINT_RULES`) replaces every group’s.
- `match` accepts globs (picomatch semantics) and `re:`-prefixed regexes against `url.pathname + url.search`; `content-type:` prefixed entries match the response type (`content-type:application/pdf`).
- `sample: 3` caps how many pages of the group expensive extractors (Lighthouse, axe) run on. Three pages per template cover every template at a fraction of the cost. `sample: all` disables. Stream mode takes the first three arrivals; accumulate mode the three lowest URLs, so a re-lint is deterministic.
- `fetch` on a group overrides the derived mode upward only; it cannot pin a group below what its rules need.
- `spiderlint groups <url>` is the dry run: crawls, prints the page count and derived fetch mode per group (with the rule that forced it), and lists pages that fell through to `default`.

## Rules

```yaml
rulesets:
  seo:
    description: SEO with longer titles    # optional; shown by `spiderlint presets` for presets
    extends: [spiderlint:seo]              # bundled preset
    rules:
      html/title-length:
        fact: html.title
        expect: { type: string, minLength: 30, maxLength: 60 }
        severity: warning
      html/one-h1:
        fact: html.h1
        expect: { minItems: 1, maxItems: 1 }
        severity: error
      http/hsts:
        fact: http.headers.strict-transport-security
        expect: { type: string, pattern: "max-age=\\d{7,}" }
        when: { url.protocol: "https:" }
      html/unique-title:
        scope: site
        unique: html.title
      html/canonical-self: off
```

- A ruleset entry for a rule it extends overrides it field by field, and `expect` keyword by keyword, so `html/title-length: {expect: {minLength: 25}}` keeps the preset’s `fact`, `when` and `maxLength`.
- A declarative rule is `fact` (dotted path into the facts document) + `expect` (JSON Schema 2020-12 applied to that value). AJV compiles it once; `ajv-i18n` localises the failure. Ranges, regexes, enums, array counts and existence all come for free, so there is no expression parser to write or secure.
- `when` is a map of fact path to a constant or to a JSON Schema the fact must satisfy (`http.status: {minimum: 200, maximum: 299}`); the rule is skipped, not failed, when any entry differs. This is how TLS rules stay quiet on `.onion` hosts. A ruleset-level `when` is merged into every rule it carries — `seo` uses it to judge 2xx pages only, so a 404 page is a `links/broken-internal` finding and never a duplicate title.
- A page rule whose extractor did not run — the fact path’s top-level key is absent, as `html` is on a JSON or RSS document — is skipped, not failed. Only a key present with a missing field is a finding.
- A rule entry with neither `fact` nor `unique` names a built-in TypeScript rule by ID (`links/broken-internal: error`); an unknown ID is a config error.
- `scope: page` (default) runs per page. `scope: group` and `scope: site` receive every facts document of that group or of the crawl; `unique: <fact>` is the only built-in aggregate, anything else is a TypeScript rule.

### Site-wide rules

Some defects exist only BETWEEN pages. Two different URLs with the same
`<title>` are each fine alone; together they are a duplicate. These rules
run once, after the crawl, over every facts document — in stream mode too,
because facts are always retained even when bodies are not.

- `unique: <fact>` at `scope: site` groups pages by the fact’s value and reports every value held by two or more DISTINCT URLs, one finding per value with the URL list. A redirect and its target count once. `html/unique-title`, `html/unique-description` and `html/unique-h1` are the SEO trio; `scope: group` narrows the same check to one template when a site legitimately repeats a title across sections.
- `sitemap/orphan` and `sitemap/unlisted` are declarative page rules over `crawl.*` and `sitemap.*`, computed after the crawl, so they fold like any template defect.
- Other site-scoped built-ins: `sitemap/unreadable` (over `site.sitemaps`), `links/broken-internal`, `links/broken-external`, `http/consistent-origin`, every `resources/*` rule, `i18n/hreflang-reciprocal` (a page naming an alternate that does not name it back).
- A site-scoped finding is already an aggregate, so folding leaves it alone; its key is the shared value (or resource URL), never a page.
- Severity: `error` | `warning` | `info` | `off`. `--error`, `--warning`, `--info`, `--disabled-rules` override per ID, as in ignorelint.
- Rule IDs are `plugin/name`, never numbered — plugins are open-ended.
- A TypeScript rule is `{ meta: { id, severity, scope, facts, docs }, check(ctx): Finding[] }`; `facts` lists the paths it reads (`['browser.console.*']`), which is what derives its fetch mode. A declarative rule derives it from `fact`. Declarative rules compile to the same interface, so formatters and folding see one kind.

Bundled presets (v1): `all` (not a file: every preset that ships or a loaded plugin adds, so it never falls behind; a user ruleset cannot take the name), `recommended`, `seo`, `security-headers`, `tls`,
`links`, `sitemap`, `browser` (console errors; never in `recommended`, which
would force every run into Chromium), `i18n` (`html.lang` vs `content-language`, hreflang
reciprocity, one locale per URL family), `cookies` (Secure, HttpOnly,
SameSite), `redirects` (chain length, http→https→www hops, mixed content).

`resources` (in `recommended`; v1 ships `status`, `mixed-content` and `sri`, fetched once per URL per run, `--no-resources` to skip): `resources/status` (a dependency that is
not `2xx`), `resources/cache-control` (a hashed or `immutable` asset without
a long `max-age`), `resources/sri` (cross-origin script or style without
`integrity`), `resources/mixed-content` (`http:` on an `https:` page),
`resources/compression` (text asset served uncompressed), `resources/tls`
(a dependency host whose certificate is near expiry). Each is `scope: site`
and keyed by RESOURCE URL: a CDN script every page loads is one finding with
`usedBy` and sample pages, never one per page.

`recommended` also carries `http/consistent-origin` (`scope: site`, `info`): for
each host it reports when `tls.cert.fingerprint256`, `tls.protocol`,
`http.remote.address` or `http.headers.server` vary across pages, listing the
URL sets per value. Two backends behind one name surface here first, and the
sets are ready-made group candidates.

## Folding

Runs after all page-scope findings exist, per `(group, rule)`:

- `failed` = pages with the finding; `applicable` = pages in the group the rule was not `when`-skipped on.
- If `applicable ≥ fold.min` (3) and `failed / applicable ≥ fold.threshold` (0.8): emit ONE finding at rule severity with `occurrences`, `coverage`, `samples` (3 URLs) and `sampleLocations` (each sample’s `locations`, by URL); drop the per-page findings.
- Otherwise emit the per-page findings unchanged.
- A group between `0.2` and `0.8` on the same rule gets an `info` advisory `groups/heterogeneous`: it likely hides two templates and wants splitting.
- A finding may carry `locations`: one line per element it points at. `human` prints up to five under each page (all of them with `--unfold`), and a fold’s samples share one list when their locations match.
- `--unfold` (`fold: false`) keeps every per-page finding, and `human` then lists every URL and location instead of the first five. Folded findings map to SARIF `occurrenceCount` plus `relatedLocations`, so code-scanning UIs show one row.
- Resource findings fold by resource URL across the whole site rather than by group: the offending artefact is the resource, the pages are its `usedBy`.

## Store

The `pages` cache bucket (see Cache). Kept as its own section because it is
the one bucket a user re-lints from.

- Crawlee storage in the site’s directory, `$XDG_CACHE_HOME/spiderlint/<host>` (`~/.cache` when unset; seed hosts sorted and `+`-joined when they span several), created owner-only; `--store DIR` names another. `crawl`, `lint`, `report` and `cache` find it from their URLs or `targets`, so none needs a flag: `Dataset` `facts` holds one facts record per page, `KeyValueStore` `bodies` the bodies keyed by URL hash, `records` the resource results, the site facts and the last report, `RequestQueue` `frontier` the frontier so `--resume` continues a killed run.
- `audit --no-cache` writes nothing. Groups, referrers and resource results are re-derived on every `lint`, so a changed group config needs no re-crawl; `report` re-formats the last stored report.
- `manifest.json`, written atomically: tool version, seeds, a hash of the crawl-shaping config, started, finished. A hash mismatch on `lint` or `--resume` warns.
- `proper-lockfile` on the manifest; a second process on the same store exits `2`.
- Authorization, cookie and proxy-auth headers are redacted before anything is written.

## Cache

Every network crossing has a bucket; every bucket has a key, a TTL, a
location and a purge. Nothing is fetched twice inside a run, and a re-run
pays only for what changed.

| Bucket       | Key                                       | Lives in                       | Fresh for                                                                                    |
| ------------ | ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `pages`      | URL                                       | the site’s store               | RFC 9111 — `Cache-Control`, `ETag`, `Last-Modified`; bucket TTL when the origin says nothing |
| `probes`     | URL of an off-scope link                  | `$XDG_CACHE_HOME/spiderlint/`  | 7 days                                                                                       |
| `resources`  | resource URL                              | the site’s store               | RFC 9111, else 24 hours — a CDN asset shared by every page is fetched once                   |
| `robots`     | host                                      | `$XDG_CACHE_HOME/spiderlint/`  | 24 hours (RFC 9309 §2.4)                                                                     |
| `sitemaps`   | sitemap URL                               | the site’s store               | `Last-Modified`, else 24 hours                                                               |
| `extractors` | `(extractor, version, URL, sha256(body))` | the site’s store               | until the body changes — a Lighthouse run is never repeated on an unchanged page             |
| `browser`    | sub-resource URL                          | one Playwright context per run | the run — CSS, JS and fonts shared by every page load once                                   |

- A re-crawl revalidates: `If-None-Match` / `If-Modified-Since` from the stored response, and a `304` keeps the content facts (`html.*`, `extractors`) while refreshing the transport facts (`http.*`, `tls.*`). `http.revalidated: true` records it. Stored pages are found by their requested URL too (`crawl.requested`), so a link through a redirect revalidates.
- Site buckets hold private staging pages and live in the site’s owner-only store; user buckets hold only third-party observations and are shared across every site on the machine.
- Writes are atomic (temp file + rename). Project buckets share the store’s lock, so a second process on the store exits `2`; the user bucket relies on atomic writes alone, so parallel audits of different sites never block each other.
- `--no-cache` bypasses every bucket for the run, `--refresh` rewrites them, `--offline` serves only from them and fails on a miss with exit `3`; an `--offline` audit lints the stored pages and fetches nothing. Per-bucket TTLs are `cache.<bucket>.ttl` in the config.
- `spiderlint cache status` lists every bucket with entries, bytes, oldest and newest; `spiderlint cache purge [bucket] [--older-than 7d]` deletes; `spiderlint cache warm <url>` fills `robots` and `sitemaps` without crawling. The shape is `pf-cli cache status|warm|purge`, which the fleet already knows.
- The action persists `$XDG_CACHE_HOME/spiderlint` through the forge’s cache keyed by target, so a CI run on an unchanged site is a run of `304`s.

## Configuration

Precedence: flags, then `SPIDERLINT_*` environment, then the `org.spiderlint`
subtree, then defaults — ignorelint’s ladder. Without `pf-cli` on `PATH`,
`--config spiderlint.yaml` accepts a plain file carrying the same subtree,
so outsiders need no projectfile.

```yaml
org:
  spiderlint:
    targets: [https://f.dbuho.me/]     # optional; the command-line urls win
    rules: [all]                       # optional; replaces every group's rules
    fetch: auto                        # auto | http | browser | adaptive
    browser: chromium                  # chromium | firefox | webkit
    scope: origin                      # origin | host | domain
    concurrency: 0                     # 0 = NUMPROCS
    rate: 0                            # requests per minute, 0 = unlimited
    max-pages: 0
    resources: { fetch: true, max-per-page: 200 }
    proxy: ""                          # socks5h://127.0.0.1:9050 for Tor
    robots: true
    sitemap: true
    fold: { threshold: 0.8, min: 3 }
    cache:
      pages: { ttl: 0 }                # 0 = origin headers decide
      probes: { ttl: 7d }
      resources: { ttl: 24h }          # when the origin sends no Cache-Control or Expires
      robots: { ttl: 24h }             # also caps what the origin allows (RFC 9309 §2.4)
      sitemaps: { ttl: 24h }
    fail-on: error
    format: human
    plugins: []                        # explicit; nothing is auto-loaded from node_modules
    groups: { … }
    rulesets: { … }
```

The shape is registered in `projectfile/specification/spec/registry.yaml`
with a fragment under `spec/shapes/org.spiderlint.yaml` once v1 ships.

## CLI

```text
spiderlint audit  [url…]                  crawl + lint into the site’s store (--no-cache streams)
spiderlint crawl  [url…]                  accumulate only
spiderlint lint   [url…]                  rules over stored facts, no network
spiderlint report [url…]                  re-format stored findings
spiderlint facts  <url>                   one page’s facts document as JSON
spiderlint groups [url…]                  page count per group, unmatched pages
spiderlint rules [ruleset…]               every rule: severity here, scope, ruleset, docs
spiderlint presets                        shipped rulesets, rule count, used by a group
spiderlint explain <rule>                 docs, default severity, fact it reads
spiderlint cache status|purge|warm        every bucket: entries, bytes, age
```

Flags mirror the config keys (`--rules`, `--fetch`, `--browser`, `--scope`, `--concurrency`,
`--rate`, `--max-pages`, `--max-depth`, `--proxy`, `--no-robots`,
`--no-sitemap`, `--format`, `--output`, `--fail-on`, `--unfold`,
`--fail-fast`, `--resume`, `--no-cache`, `--refresh`, `--offline`,
`--header`, `--cookie`, `--user-agent`, `--locale`). Results go to stdout, diagnostics to stderr; `human` and `--help` color on a TTY only; `NO_COLOR`, `FORCE_COLOR` and `--[no-]color` honoured.

## Plugins

```ts
export default definePlugin({
  name: 'html-validate',
  extractors: [{ id: 'htmlvalidate', async extract(page, body, live) {…} }], // facts land under page.htmlvalidate
  rules:      { 'html-validate/no-dup-id': (severity) => ({ meta, check }) }, // the built-ins’ shape
  presets:    { 'html-validate': { description, rules } },
})
```

- Bundled plugins are always registered. `plugins` names the others: a path (`./`, `../`, `/`) from the working directory, else a package resolved beside spiderlint. Nothing is discovered from `node_modules`. A plugin redefining a rule, preset or extractor ID is a config error.
- An extractor runs only when an enabled rule reads a fact under its ID, as a `browser.*` rule forces Chromium. It sees every fetched page with its body and returns `undefined` to add nothing; one that throws logs a warning and leaves its key absent, so its rules skip.
- Extractor facts are stored with the page. `lint` and `--offline` run an extractor the stored facts lack against the stored body, so enabling a plugin’s rules needs no re-crawl.
- Plugin presets sit beside the shipped ones and list in `spiderlint presets`; `<plugin>:<variant>` names a variant (`html-validate:a11y`).
- An extractor with `mode: browser` gets the crawler’s live Playwright page as `live`, runs only on a rendered HTML page, and forces the browser crawl as a `browser.*` rule does. `lint` and `--offline` cannot backfill it from a stored body; a store lacking its facts warns once.
- Later: `formatters` and `sources`; `cost: expensive` on extractors, obeying the group `sample`; the `extractors` cache bucket.
- `html-validate` runs html-validate’s `recommended` and `document` presets. `require-sri` is narrowed to cross-origin scripts, which `resources/sri` also judges. A rendered DOM is Chromium’s serialisation, so browser mode adds html-validate’s `browser` preset. A body truncated at `max-body-size` is skipped: its cut-off elements would all fail. Facts are `htmlvalidate.messages[]` (`rule`, `message`, `severity`, `line`, `column`, `offset`, `size`, `selector`, `source` — the tag at the offset — and `context`); each html-validate rule is the rule `html-validate/<id>`, one finding per distinct message per page with its locations as the value and `line:column selector <tag>` as `locations`. Presets: `html-validate`, `html-validate:standard`, `html-validate:a11y`, `html-validate:document`; `all` carries them, `recommended` does not.
- `axe` runs axe-core through `@axe-core/playwright` in the crawler’s own rendered page (pa11y would launch a second browser), with axe’s default rule set: no experimental, AAA or obsolete rules. Facts are `axe.version`, `axe.violations[]` and `axe.incomplete[]` (`rule`, `impact`, `tags`, `description`, `help`, `error`, and `nodes[]` with `target`, `html`, `xpath`, `ancestry`, `impact`, `summary` and the `any`/`all`/`none` checks, each with `message`, `data` and `related` elements); each axe rule is the rule `axe/<id>`, one finding per violated rule per page with its impact and elements as the value and `selector <tag>, related: …` as `locations`. Presets: `axe` (WCAG A and AA rules as errors, best practices as warnings), `axe:wcag`, `axe:best-practice`; `all` carries them, `recommended` does not.
- Next: `lighthouse`, reconnecting over CDP to the crawler’s Chromium via `playwright-lighthouse`, so it re-navigates but shares the browser. `linkinator` is not wrapped: internal links are answered from the store and external ones by rate-limited `HEAD` probes with a per-host cache.

## Concurrency and limits

- Crawl: Crawlee’s autoscaled pool, `maxConcurrency` = `NUMPROCS` by default, browser mode halves it. `maxRequestsPerMinute` from `rate`, `sameDomainDelaySecs` from `Crawl-delay`.
- Lint from store: `piscina` worker pool sized `NUMPROCS` for static extractors; rules themselves are cheap and run inline.
- Retries: `maxRequestRetries: 3` with Crawlee’s backoff; `429` and `503` honour `Retry-After`. `retryOnBlocked` stays off — evading bot protection on someone else’s site is not this tool’s job.
- Timeouts: `requestHandlerTimeoutSecs` 60, navigation 30; `--profile tor` raises both, drops concurrency to 4, and disables adaptive detection.
- Keep-alive is on; `--no-keepalive` trades connection reuse for one TLS observation per page.

## Tor, I2P, unusual hosts

- `--proxy socks5h://127.0.0.1:9050` — the `h` is mandatory so `.onion` names resolve inside Tor, never on the host. I2P is `--proxy http://127.0.0.1:4444`.
- Playwright takes the proxy through `--proxy-server`; verified upstream (apify/crawlee#3430). SOCKS through the HTTP crawler’s `got-scraping` is a spike task — fallback is `--fetch browser` for Tor targets.
- No assumption is baked in that a site has TLS, resolvable DNS, a sitemap, or answers in under a second. Every such property is a fact a rule may require, guarded by `when`.
- `Onion-Location` is captured as a header fact for the `i18n`/`redirects` presets to reason about later.

## Security

- User agent identifies the tool: `spiderlint/<version> (+https://kiota.ch/damian-buho/spiderlint)` on every page, resource and sitemap request, and `robots.txt` groups are matched for `spiderlint`. spiderlint fetches `robots.txt` and the sitemap candidates itself, so they carry it too.
- Secrets arrive only through `--header` / `--cookie` / environment, are redacted from logs and the store, and never appear in findings.
- Scope restricts what is fetched; off-scope links are probed with `HEAD` only.
- `--no-robots` warns; `retryOnBlocked` is never enabled.
- Plugins load by explicit name only. Chromium runs as the `b19` user, never root.
- The store can hold private staging pages; it lives owner-only in the user cache, never beside the project, and its path is logged on every run.

## Observability

- `pino` JSON logs to stderr, `--log-level` (`info` default). On a terminal each entry is one line: message, URL, error; its other fields show only when it has neither, or at `debug`. Crawlee’s own log is bridged into the same stream.
- When every seed shares one origin, that origin is logged once and every logged URL under it prints as its path; other origins, and runs with mixed-origin seeds, stay absolute. `human` does the same with the origin every page shares, printed once on top; `json`, `sarif` and the store always carry absolute URLs.
- Every decision logs its variables: group assignment (`url`, `group`, `matched`), rule skip (`rule`, `when`, `actual`), fold (`group`, `rule`, `failed`, `applicable`, `ratio`), sampling (`group`, `extractor`, `taken`, `cap`), robots skip (`url`, `rule`).
- The run summary is a fact document too: pages, bytes, duration, per-group counts, per-status counts and `cost` — browser launches and the pages they rendered, plain HTTP fetches and revalidations, resource requests and cache hits, runs per extractor — printed by `human`, embedded in `json` and `sarif` `invocations`.
- `human` prints unfolded page findings that share severity, rule and message once, with one page per line under them; `json` and `sarif` keep one finding per page.

## i18n

- Finding messages, `human` output and `--help` in `en`, `es`, `uk` through `gettext-parser`, as textlint-server does. `--locale` and `LANG` select.
- Rule IDs, fact paths and config keys are never translated.
- Docs are typographic (`’`, `…`); anything copied into generated docs (`description:` fields, help text) follows.

## Repository layout

```text
src/
├── cli.ts              # argument parsing, exit codes
├── index.ts            # library API: audit(), crawl(), lint(), report()
├── config/             # pf-cli reader, plain-file reader, schema, precedence
├── crawl/              # Crawlee adapters (http, browser, adaptive), robots, scope, proxy
├── sources/            # seeds, sitemap
├── facts/              # facts types, extractor runner, worker pool
├── groups/             # matcher, assignment, sampling
├── rules/              # Rule interface, declarative compiler, scopes
├── fold/               # saturation folding
├── cache/              # buckets, TTL, RFC 9111 freshness, atomic writes, locks
├── store/              # the pages bucket: Crawlee storage wrapper, manifest, redaction
├── report/             # formatters
├── plugins/            # contract, registry, bundled html-validate and axe (lighthouse next)
└── i18n/
presets/                # recommended.yaml, seo.yaml, security-headers.yaml, …
locales/                # es/, uk/
tests/                  # node:test; fixtures/site/ is a static multi-template site served locally
docs/                   # cli.md, rules.md, facts.md, formats.md, features.d/
.container/             # image assets, as ignorelint
action.yaml             # docker action: urls, store, sarif, fail_on, comment
projectfile.yaml
```

## Build and CI

- `B19_NODE_SERIES: 26` under `org.projectfile.build.args` picks the series; the Dockerfile `ARG` default is only the fallback name.
- `projectfile.yaml` includes `.makefile/b19/ci.yaml`, `.makefile/b19/images/node.yaml`, `.makefile/library/languages/node.yaml`, and the `damian-buho/metadata` include plus the `forge/github.yaml`, `forge/codeberg.yaml`, `registry/ghcr.yaml` fragments — copy ignorelint’s block, swap the language.
- `org.projectfile.image.org: damian-buho`, `flatpath: ${name}`, `sinks.ghcr.selfref` — the account-is-org shape every personal image carries.
- `build.d/user/post/700-install-chromium.sh` installs the headless shell of the pinned `playwright` (`--only-shell`: headless runs never launch the full browser) into `PLAYWRIGHT_BROWSERS_PATH`; nothing downloads at runtime. Its libraries are curated in `.container/root/deps/common.apt.deps` from Playwright’s own per-distribution list, not `--with-deps`.
- Self-test in `test.d/`: audit the bundled fixture site served from inside the container and expect the known findings, once over http and once in Chromium.
- `make` runs the m6e gates; lint, format, audit, outdated checks and `npm-test` (under `source-is-tested`) come from the node fragment. `NODE_TOOL_IMAGE.series` is overridden to `26` in the projectfile because the fragment pins `24` while the base image follows `B19_NODE_SERIES`.

## Testing

- `node --test --experimental-strip-types tests/**/*.test.ts`, no other runner.
- `tests/fixtures/site/` is a static site with three templates (post, tag, app), `robots.txt`, `sitemap.xml` naming an unlinked `/orphan`, an XML feed, a `/private/` robots disallow, a `/tmp/` path for `--exclude` and a dead `/missing` link, served by `tests/fixtures/server.ts` on an ephemeral port with an HTML 404 for anything else. Every rule has a passing and a failing page there; the post template is missing `<h1>` on every page so folding is exercised end-to-end. Fixture files carry inline SPDX comments, no `.license` sidecars.
- Formatter output is snapshot-tested; SARIF is validated against the 2.1.0 schema.
- No test reaches the network. External-link probes point at the same local server.
- `tests/browser.test.ts` skips its Chromium suite when a launch fails, which it does in the node tool image `npm-test` runs in; the image self-test is where Chromium is proven.

## Later

- `--baseline previous.json`: report only new findings, SARIF `baselineState`.
- Template fingerprinting: hash the DOM skeleton (tag paths, no text) per page; cluster; `spiderlint groups --suggest` proposes groups, and `match: [fingerprint:<hash>]` groups pages whose URLs do not reveal their template.
- String assertion sugar (`title.length in 30..60`) compiling to the same JSON Schema, only if the schema form proves clumsy in practice.
- `tls/probe` extractor (`cost: expensive`): dedicated handshakes keyed by `(host, remote.address)` — protocol versions still accepted, weak ciphers, OCSP stapling, chain completeness. Keyed by address, not host, so two backends behind one name get two probes.
- Screenshot per sampled page in browser mode; visual diff against baseline.
- Multi-arch once `b19/node` is.

## Open decisions

- Fold threshold `0.8` and minimum `3` are guesses. The fixture site and the first audit of f.dbuho.me decide.
