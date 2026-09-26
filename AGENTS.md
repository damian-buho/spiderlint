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
discovery, scope, depth, glob and body-size limits; a fetch mode derived per
group, both crawlers side by side in one run, and `adaptive` detection per group; sitemap discovery and facts; transport,
TLS and resource facts; groups; declarative and built-in rules, presets
`seo`, `security-headers`, `performance`, `links`, `tls`, `cookies`, `redirects`, `sitemap`, `robots`, `i18n`,
`resources`, `browser`, `recommended`, `all`; site-wide `unique`; folding; `human`, `json`,
`sarif`, `checkstyle`, `csv`; checks passed and the S–F rating; `pf-cli` and plain-file config; `sites` with `--site`; the store with `crawl`, `lint`,
`report` and `--resume`; the `pages`, `resources`, `sitemaps`, `robots`, `probes` and `extractors`
buckets with RFC 9111 revalidation, `cache status|purge|warm`, `--no-cache`,
`--refresh` and `--offline`; `concurrency`, `rate` and `proxy`, SOCKS included; `rules`, `presets` and `explain`; plugins with extractors, rules, presets, formatters and sources, the bundled `list` source, browser-mode
extractors, extractor `cost` with the group `sample`, site extractors per origin or host with the `origins` bucket and the probe address guard, resource extractors, the bundled `html-validate`, `htmlhint`, `axe`, `keyboard`, `live`, `lighthouse`, `origin`, `dns` with the `dns` bucket and `--resolver`, `tls-probe`, `images`, `well-known`, `feeds`, `structured-data`, `manifest`, `link-text`, `markup` and `trackers`; the fixture site. Not yet: localised messages.
The rest of this document is the specification the remaining parts are built from.
Sections marked *v1* are in scope for the first release; *later* rows are
recorded so the v1 shape does not block them.

## Key facts

- Base: `b19/node-26`, TypeScript run directly by Node (`--experimental-strip-types`), no build step — same as [textlint-server](../textlint-server/AGENTS.md)
- Crawler: [Crawlee](https://crawlee.dev/js/docs/quick-start) 3.18 — `HttpCrawler` (cheerio) by default, `PlaywrightCrawler` on demand, both side by side when groups need both
- Image: `damian-buho/spiderlint` with the Chromium headless shell baked in (`PLAYWRIGHT_BROWSERS_PATH`, as [d9t/mcphub](../../d9t/mcphub/AGENTS.md) does); amd64 only, because `b19/node` is
- Config: the `org.spiderlint` projectfile subtree, read through `pf-cli get -f document org.spiderlint` — never parsed by spiderlint itself, exactly as [ignorelint](../ignorelint/docs/cli.md#configuration) reads `org.ignorelint`
- Output: `human` (default), `json`, `sarif`, `checkstyle`, `csv` — same names ignorelint uses
- Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` bad arguments or config, `3` no seed could be fetched, `4` the run failed after it started
- External tools (`openssl` …) are allowed: the image installs them, and a check whose tool is not on `PATH` is skipped with one run-level warning naming the tool, never a finding or a failure
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
| Target    | A seed URL, from the command line, `org.spiderlint.targets` or a site’s `targets`. With none, the command prints its usage.       |
| Page      | One fetched URL: request, response, body, and everything derived from them.                                                       |
| Facts     | The JSON document extractors build for a page. Rules read facts and nothing else.                                                 |
| Extractor | Code that turns a page into facts: static (the body) or live (the open browser page). A site extractor does one origin or host.   |
| Resource  | A sub-request a page depends on: script, style, image, font, iframe, preload, manifest. Any origin; linted, never crawled.        |
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

- Seeds: CLI URLs, else each selected site’s `targets`, else `spiderlint.targets`. Projectfile `links` never seed a crawl.
- Sitemap: `robots.txt` `Sitemap:` lines plus `/sitemap.xml`, `/sitemap.txt` and `/sitemap_index.xml` when no seed names a sitemap. spiderlint fetches every file and every same-host file an index names itself, gunzips by magic bytes, and hands the text to Crawlee’s parser; each file becomes a `site.sitemaps` entry. Union with discovered links. The difference is itself lint input: `sitemap/orphan` (listed, never linked) and `sitemap/unlisted` (linked, never listed); a file that does not fetch, does not parse or names no URL is `sitemap/unreadable`.
- Robots: spiderlint reads `robots.txt` through the `robots` bucket and hands it to Crawlee’s `respectRobotsTxtFile` — disallowed URLs are skipped and logged through `onSkippedRequest`; a `4xx` allows everything and a `5xx` or no answer disallows everything (RFC 9309 §2.3.1); `Crawl-delay` maps to `sameDomainDelaySecs`, the longest over the seed origins, since Crawlee applies one delay to every domain. Crawlee keeps its parser private, so `crawl/robots.ts` parses each file once more (RFC 9309 groups, `Sitemap:`, `Content-Signal:`) for both `Crawl-delay` and `site.robots`, one entry per seed origin; only a `2xx` body is parsed. `--no-robots` prints a warning and is intended for staging hosts.
- Scope: `origin` (default), `host` (any port and scheme), `domain` (subdomains). Scope governs what is CRAWLED — which pages are fetched and parsed for more links.
- Off-scope LINKS (`<a href>`) are recorded as facts and, when `links/broken-external` is enabled, probed for existence only: `HEAD`, `GET` on a `405`, one request at a time per host, each answer in `site.links`. A host `links.exclude` names, or a subdomain of one, is never asked. A `429`, a bot wall (`cf-mitigated: challenge`, LinkedIn’s `999`) or a guard-refused address is not judged, and only a healthy or walled answer is cached, so a fixed link clears on the next run.
- RESOURCES are different: a script, style sheet, image, font or iframe a page loads is our dependency whatever its origin. A CDN script with a bad `Cache-Control`, no `integrity`, or an expiring certificate is our finding. Resources are fetched with `GET` once per URL (see the `resources` bucket), never parsed for links, and their facts hang off the page that loads them.
- Limits: `--max-pages` (`maxRequestsPerCrawl`), `--max-depth` (`maxCrawlDepth`), `--include` / `--exclude` globs applied before enqueue.
- Bodies: HTML, XML and JSON are read up to `--max-body-size` (10 MB); any other type is judged by its headers and its download aborted once they arrive — one round trip, where `HEAD` then `GET` would cost two. `http.size.truncated` marks both.
- Head feeds (`rel=alternate` of an RSS, Atom or JSON Feed type) are queued with the anchors under the same scope and globs, and crawled as pages; `rel=manifest` is a resource of kind `manifest`.
- `rel=nofollow` and `<meta name=robots content=nofollow>` are facts, not crawl barriers — the owner audits their own site.

## Fetch

| Mode       | Crawlee class           | When                                                                                    |
| ---------- | ----------------------- | --------------------------------------------------------------------------------------- |
| `http`     | `HttpCrawler` + cheerio | Default. 10–50× cheaper than a browser.                                                 |
| `browser`  | `PlaywrightCrawler`     | SPAs, pages whose meta tags are rendered client-side.                                   |
| `adaptive` | both                    | Unknown sites: renders a group’s first pages, then settles the whole group on one mode. |

The mode is DERIVED per group, never guessed. Every fact path belongs to an
extractor, and every extractor declares the mode it needs (`html.*` and
`http.*` are `http`; `browser.*`, `lighthouse.*`, `axe.*` are `browser`).
A group’s mode is the highest mode any of its enabled rules reads — one rule
on `browser.console.errors` upgrades its whole group, and since a page is
fetched once, upgrading the group is exactly upgrading the job for those
pages. `spiderlint groups` prints each group’s mode; the rule that forced it is logged at `debug`.

`fetch` values: `auto` (default — derived as above; a group nothing forces
runs `http`, so a default run never launches a browser), `http` (pin; a
browser-only rule, or a group pinned `browser` or `adaptive`, is then a config
error, exit `2`), `browser` (force everything), `adaptive` (every group
nothing forces `browser` detects its own mode).
Overridable per group (`groups.app.fetch: browser` or `adaptive`) for sites whose
meta tags are rendered client-side — a site property no rule can declare.

One run starts only the crawlers its groups need, side by side over one
frontier: a URL is queued on its group’s crawler, matched by URL alone, since
its response is not known yet. An `adaptive` group queues on http, which hands
its first three pages to the browser; each rendered page’s `html` facts (title,
lang, canonical, `h1`, meta, `og:` properties, internal links) are compared
with the same response’s static HTML. One difference settles the group on
`browser`, three agreements on `http`; later pages wait for the verdict, and
a group still undecided after 60 s renders. So a group’s pages are fetched
one way once it settles, and a rendered page costs no second request.
Crawlee’s `AdaptivePlaywrightCrawler` is not used: its HTTP path reads no
socket, timings or `304`, and it decides per page, which would split a group’s facts.

`browser` picks the Playwright engine (`--browser`, `SPIDERLINT_BROWSER`). The image ships Chromium only; `firefox` and `webkit` run where Playwright has them installed, and one that is missing is a config error naming `npx playwright install <name>`.

The browser also yields facts HTTP cannot: console errors, Navigation Timing,
and the COMPLETE resource census — including what JavaScript loads at
runtime, which the http mode’s static parse of `src`/`href`/`srcset` cannot see.
The `resources` extractor runs in both modes; browser mode marks each entry
`observed: true` and adds the ones only the network log knows — a request the
browser blocked (ORB, CSP) or that failed counts as observed.

Early Hints are read from the `information` events of the last hop’s request, through a got `beforeRequest` hook that wraps the request function got-scraping chose. Over HTTP/2 `http2-wrapper` passes a 103’s status but not its headers, so the entry carries no `link`.

Browser mode reads less of the connection than http mode: no `http.earlyHints`.
Chromium reports the TLS protocol, subject, issuer and validity; one Node handshake per
host and address it connected to adds cipher, ALPN, fingerprint, SAN and the verdict
when it meets the same certificate, and `http.version` follows from its ALPN (`3.0`
over QUIC, `1.1` on plain text). A proxied run sends no handshake. It never sends conditional requests; a stored page is
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
a once-per-host probe would hide that, which is why browser mode’s handshake is keyed by host and address and trusted only on Chromium’s certificate. With keep-alive, pages sharing a
connection share the same observation; `--no-keepalive` forces a fresh
handshake per page for a complete census at the cost of speed.
The CLI trusts the OS certificate store beside Node’s bundled roots, as
`node --use-system-ca` does, so a locally trusted development CA passes
`tls/authorized` with no flag.

## Facts document

The single contract between extractors and rules. Dump it for any page with
`spiderlint facts <url>`; writing a rule is reading this JSON and writing a
schema against it.

```yaml
url:      { href, origin, protocol, host, pathname, search, twin }   # twin: the same URL on canonical-origin
group:    posts
crawl:    { depth, discoveredVia: seed|sitemap|link, referrers: [], inDegree, requested }
robots:   { noindex, nofollow }                                    # <meta name=robots> and X-Robots-Tag, derived on every lint
sitemap:  { listed, lastmod, changefreq, priority, alternates: [{ lang, href }], images, videos }
http:     { status, version, redirects: [{ url, status, headers, by }],
            headers: { name: value | [value] }, remote: { address, family },
            timing: { dns, tcp, tls, ttfb, download, total },
            size: { body, decoded, declared, truncated }, contentType, charset,
            cookies: [{ name, secure, httpOnly, sameSite, path, domain }],
            earlyHints: [{ link }] }                                   # each 103’s Link, http mode only
tls:      { protocol, cipher, alpn, authorized, error,          # from this page’s connection
            cert: { subject, issuer, notBefore, notAfter, daysLeft, san: [], fingerprint256 } }
html:     { lang, dir, charset: { declared, offset }, title, h1: [], h2: [], canonical,   # offset: byte where the declaring <meta> ends
            meta: { name: content }, metas: [{ name, content, media }], property: { og:title: … },   # meta: first per name; metas: every one
            head: { links: [{ rel, href, type, hreflang, sizes, media, as, crossorigin }] },
            links: { internal: [], external: [], nofollow: [] },
            images: [{ src, alt, width, height, srcset, loading, noscript }], hreflang: [{ lang, href }],
            rels: { privacy-policy: [href] },                        # rel token → hrefs, over <a>, <area> and <link>
            inputs: [{ type, autocomplete, inputmode }],               # type lowercased, `text` when unset
            jsonld: [],                                              # parsed blocks; an unparsable one is { "@error": message }
            scripts: [{ src, type, async, defer, head }], wordCount, generator }
resources: [{ url, kind: script|style|image|font|iframe|preload|manifest, origin: same|cross,
              integrity, crossorigin, observed,                 # from the HTML, or the network log
              http: { status, headers, timing, size, contentType, cookies }, tls: { … },   # cookies: the resource’s own Set-Cookie, as http.cookies
              <resource extractor ID>: … }]
browser:  { timing: { domContentLoaded, load }, console: { errors: [], warnings: [] },
            weight: { script, style, image, font },
            cookies: [] }                                                # document.cookie writes, as http.cookies; values cut in the page
```

Facts about the site rather than one page form a second document, handed to
group and site rules beside the pages:

```yaml
site:     { sitemaps: [{ url, status, urls, sitemaps, error }],
            robots: [{ url, status, error, groups: [{ agents, allow, disallow, crawlDelay }], sitemaps: [],
                       contentSignals: [{ agents, value, signals: { search: yes|no } }] }],   # per seed origin; agents lower-cased
            origins: { "https://example.org": { <site extractor ID>: … } },   # per: origin
            hosts: { "example.org": { <site extractor ID>: … } },            # per: host
            linked: [] }                                                     # hosts in `hosts` only linked or loaded, never crawled
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
- `sample: 3` caps how many pages of the group expensive extractors (Lighthouse, axe) run on. Three pages per template cover every template at a fraction of the cost. `sample: all` disables, and is the implicit `default` group’s, so a config without groups checks every page. A crawl takes the first arrivals; `lint` backfilling a stored crawl fills each sample with the lowest URLs, so a re-lint is deterministic.
- `fetch` on a group overrides the derived mode upward only; it cannot pin a group below what its rules need.
- `spiderlint groups <url>` is the dry run: crawls, prints the page count and fetch mode per group, and lists pages that fell through to `default`.

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

- `canonical-origin` audits a staging twin serving pages built for another origin: `html/canonical-self` and `html/og-url-self` accept the page’s `url.twin`, and sitemap URLs on that origin, from `robots.txt` and `<loc>`, are read from the crawled one. A self reference to the wrong path still fails.
- A ruleset entry for a rule it extends overrides it field by field, and `expect` keyword by keyword, so `html/title-length: {expect: {minLength: 25}}` keeps the preset’s `fact`, `when` and `maxLength`.
- A declarative rule is `fact` (dotted path into the facts document) + `expect` (JSON Schema 2020-12 applied to that value). AJV compiles it once; `ajv-i18n` localises the failure. Ranges, regexes, enums, array counts and existence all come for free, so there is no expression parser to write or secure.
- `fix` is one line telling the owner what to change; `explain` prints it, and a ruleset entry’s `fix` or `docs` overrides a built-in’s.
- `message` is the finding’s sentence, `{got}` standing for the offending value (`none` when absent); every shipped declarative rule carries one. Without it the finding reads AJV’s wording against the fact path. An override that sets `expect` without `message` drops the inherited one, which may state the old bounds.
- `when` is a map of fact path to a constant or to a JSON Schema the fact must satisfy (`http.status: {minimum: 200, maximum: 299}`); the rule is skipped, not failed, when any entry differs. This is how TLS rules stay quiet on `.onion` hosts. A ruleset-level `when` is merged into every rule it carries — `seo` uses it to judge 2xx pages only, so a 404 page is a `links/broken-internal` finding and never a duplicate title.
- A page rule whose extractor did not run — the fact path’s top-level key is absent, as `html` is on a JSON or RSS document — is skipped, not failed. Only a key present with a missing field is a finding.
- A `fact` under `site.origins.*.` or `site.hosts.*.` is a site rule judged once per subject whose facts carry the extractor’s ID, keyed by the origin or host, so it never folds; only `when` paths under the same prefix apply, and with no such subject it counts no check. `linked: true` on a `site.hosts.*.` rule also makes every host the pages link or load under a crawled host’s registrable domain (at most 32 per run, listed in `site.linked`) a subject of the extractors it reads; every other rule skips those hosts. Off by default.
- A rule entry with neither `fact` nor `unique` names a built-in TypeScript rule by ID (`links/broken-internal: error`); an unknown ID is a config error.
- `scope: page` (default) runs per page. `scope: group` and `scope: site` receive every facts document of that group or of the crawl; `unique: <fact>` is the only built-in aggregate, anything else is a TypeScript rule.

### Site-wide rules

Some defects exist only BETWEEN pages. Two different URLs with the same
`<title>` are each fine alone; together they are a duplicate. These rules
run once, after the crawl, over every facts document — in stream mode too,
because facts are always retained even when bodies are not.

- `unique: <fact>` at `scope: site` groups pages by the fact’s value and reports every value held by two or more DISTINCT URLs, one finding per value with the URL list. A redirect and its target count once. `html/unique-title`, `html/unique-description` and `html/unique-h1` are the SEO trio; `scope: group` narrows the same check to one template when a site legitimately repeats a title across sections.
- `sitemap/orphan` and `sitemap/unlisted` are declarative page rules over `crawl.*` and `sitemap.*`, computed after the crawl, so they fold like any template defect.
- `sitemap/hreflang` (page) fails when the sitemap alternates and the page’s hreflang links both exist and differ; `sitemap/media` (site) probes each image and video entry through the `probes` bucket, keyed by the file.
- `http/early-hints-preload` (`performance`, `info`) is a page built-in: a preload a 103 hinted that the final `Link` header lacks.
- Other site-scoped built-ins: `sitemap/unreadable` (over `site.sitemaps`), the `robots` preset over `site.robots` — `robots/disallow-all` (`*` shut out of `/` with no `Allow`), `robots/ai-crawlers` (`info`: the AI crawler tokens a `robots.txt` names, by purpose, with retired ones marked) and `robots/content-signal` (only `search`, `ai-input`, `ai-train`, each `yes` or `no`), `links/broken-internal`, `links/redirected-internal` (a link whose target answers 3xx, with every page carrying it), `links/broken-external`, `http/consistent-origin`, every `resources/*` rule, `i18n/hreflang-reciprocal` (a page naming an alternate that does not name it back).
- A site-scoped finding is already an aggregate, so folding leaves it alone; its key is the shared value (or resource URL), never a page.
- Severity: `error` | `warning` | `info` | `off`. `--error`, `--warning`, `--info`, `--disabled-rules` override per ID, as in ignorelint.
- Rule IDs are `plugin/name`, never numbered — plugins are open-ended.
- A TypeScript rule is `{ meta: { id, severity, scope, facts, docs, fix }, check(ctx): Finding[] }`; `facts` lists the paths it reads (`['browser.console.*']`), which is what derives its fetch mode. A declarative rule derives it from `fact`. Declarative rules compile to the same interface, so formatters and folding see one kind.

Bundled presets (v1): `all` (not a file: every preset that ships or a loaded plugin adds, so it never falls behind; a user ruleset cannot take the name), `recommended`, `seo`, `security-headers`, `performance` (compression, caching, validators, HTTP version — HTTP only, never browser), `tls`,
`links`, `sitemap`, `browser` (console errors and `cookies:browser`; never in `recommended`, which
would force every run into Chromium), `i18n` (`html.lang` vs `content-language`, hreflang
reciprocity, hreflang targets answering `2xx`), `cookies` (Secure, HttpOnly,
SameSite, `__Host-` with `Secure`, `Path=/` and no `Domain`, `__Secure-` and `SameSite=None` with `Secure`, a lifetime of at most 400 days; one table in `plugins/cookies.ts` judges the page’s `http.cookies` as `cookies/<check>`, each resource’s own `Set-Cookie` as `cookies/resource-<check>` keyed by resource URL, and, as `cookies:browser`, what scripts write through `document.cookie` as `cookies/script-<check>`, HttpOnly aside. An init script wraps the `document.cookie` setter and cuts each value before it leaves the page; Chromium’s jar is not read, since it reports an unset SameSite as `Lax`, caps lifetimes and drops what it rejects), `privacy` (`trackers` and `cookies/before-consent`, `info`: the `consent` extractor, `mode: browser` and `cost: expensive`, loads each sampled page once more in a fresh context and keeps its jar before any interaction as `consent.cookies`, each `name`, `domain`, `party` (`first` or `third` against the page’s registrable domain) and `lifetime`, never a value, and the keys scripts wrote to `localStorage` and `sessionStorage` as `consent.storage`, which `cookies/storage-before-consent` lists; a third-party cookie, or a first-party one `cookies-registry.ts` names, hand-kept as `trackers-registry.ts` is, is a finding that says what was set and by whom and claims no legal verdict; outside `recommended`), `robots` (in `recommended`), `redirects` (chain length, a temporary hop to a 2xx page, http→https→www hops, mixed content).

`resources` (in `recommended`; v1 ships `status`, `mixed-content` and `sri`, fetched once per URL per run, `--no-resources` to skip): `resources/status` (a dependency that is
not `2xx`), `resources/cache-control` (a hashed or `immutable` asset without
a long `max-age`), `resources/sri` (cross-origin script or style without
`integrity`), `resources/mixed-content` (`http:` on an `https:` page),
`resources/compression` (text asset served uncompressed), `resources/tls`
(a dependency host whose certificate is near expiry). Each is `scope: site`
and keyed by RESOURCE URL: a CDN script every page loads is one finding with
`usedBy` and sample pages, never one per page. In browser mode a resource the page
loaded is answered from Chromium’s network log, its body kept only for a type a
resource extractor reads; only the rest is fetched, an image with the `Accept`
Chromium sends for one, so an origin negotiating AVIF or WebP answers as it would a browser.

`recommended` also carries `http/consistent-origin` (`scope: site`, `info`): for
each host it reports when `tls.cert.fingerprint256`, `tls.protocol`,
`http.remote.address` or `http.headers.server` vary across pages, listing the
URL sets per value. Two backends behind one name surface here first, and the
sets are ready-made group candidates.

## Folding

Runs after all page-scope findings exist, per `(group, rule)`:

- `failed` = pages with the finding; `applicable` = pages in the group the rule was not `when`-skipped on, only the sampled ones for a rule reading an expensive extractor.
- If `applicable ≥ fold.min` (3) and `failed / applicable ≥ fold.threshold` (0.8): emit ONE finding at rule severity with `occurrences`, `coverage`, `sampled` (the sampled page count, when the group outnumbers its sample; `human` prints “N of M sampled pages”), `samples` (3 URLs) and `sampleLocations` (each sample’s `locations`, by URL); drop the per-page findings.
- Otherwise emit the per-page findings unchanged.
- A group between `0.2` and `0.8` on the same rule gets an `info` advisory `groups/heterogeneous`: it likely hides two templates and wants splitting.
- A finding may carry `locations`: one line per element it points at. `human` prints up to five under each page (all of them with `--unfold`), and a fold’s samples share one list when their locations match.
- `--unfold` (`fold: false`) keeps every per-page finding, and `human` then lists every URL and location instead of the first five. Folded findings map to SARIF `occurrenceCount` plus `relatedLocations`, so code-scanning UIs show one row.
- Resource findings fold by resource URL across the whole site rather than by group: the offending artefact is the resource, the pages are its `usedBy`.

## Rating

- A check is one rule judged on one subject: a page rule on a page it was not `when`-skipped on, a group rule on a non-empty group, a site rule on a non-empty crawl. Counted before folding.
- A check fails on any finding above `info`; several findings on one page are still one failed check. `info` is advice and passes.
- The grade is fixed so it compares across sites: S with no failed check, then A ≥ 90 %, B ≥ 70 %, C ≥ 60 %, D ≥ 40 %, E ≥ 20 %, F below. A check failed with an `error` caps the grade at B. No checks, no grade.
- A grade names the rulesets it was earned under (`rating A (seo, links)`); grades under different rulesets do not compare.

## Store

The `pages` cache bucket (see Cache). Kept as its own section because it is
the one bucket a user re-lints from.

- Crawlee storage in the site’s directory, `$XDG_CACHE_HOME/spiderlint/<host>` (`~/.cache` when unset; seed hosts sorted and `+`-joined when they span several), created owner-only; `--store DIR` names another. `crawl`, `lint`, `report` and `cache` find it from their URLs or `targets`, so none needs a flag: `Dataset` `facts` holds one facts record per page, `KeyValueStore` `bodies` the bodies keyed by URL hash, `records` the resource results, the site facts and the last report, `RequestQueue`s `frontier` and `frontier-browser` each crawler’s frontier, so `--resume` continues a killed run.
- `audit --no-cache` writes nothing. Groups, referrers and resource results are re-derived on every `lint`, so a changed group config needs no re-crawl; `report` re-formats the last stored report.
- `manifest.json`, written atomically: tool version, seeds, a hash of the crawl-shaping config, started, finished. A hash mismatch on `lint` or `--resume` warns.
- `proper-lockfile` on the manifest; a second process on the same store exits `2`.
- Authorization, cookie and proxy-auth headers are redacted before anything is written; a `Set-Cookie` keeps its name and attributes, never its value.

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
| `origins`    | `(site extractor, origin or host)`        | the site’s store               | 24 hours; a failed or timed-out run is not stored                                            |
| `dns`        | `(server, name, type, CD)`                | the site’s store               | the smallest record TTL of the answer, at least the bucket TTL (60 s)                        |
| `extractors` | `(extractor, version, URL, sha256(body))` | the site’s store               | until the body changes — an html-validate run is never repeated on an unchanged page         |
| `browser`    | sub-resource URL                          | one Playwright context per run | the run — CSS, JS and fonts shared by every page load once                                   |

- A re-crawl revalidates: `If-None-Match` / `If-Modified-Since` from the stored response, and a `304` keeps the content facts (`html.*`, `extractors`) while refreshing the transport facts (`http.*`, `tls.*`). `http.revalidated: true` records it. Stored pages are found by their requested URL too (`crawl.requested`), so a link through a redirect revalidates.
- Site buckets hold private staging pages and live in the site’s owner-only store; user buckets hold only third-party observations and are shared across every site on the machine.
- Writes are atomic (temp file + rename). Project buckets share the store’s lock, so a second process on the store exits `2`; the user bucket relies on atomic writes alone, so parallel audits of different sites never block each other.
- `--no-cache` bypasses every bucket for the run, `--refresh` rewrites them, `--offline` serves only from them and fails on a miss with exit `3`; an `--offline` audit lints the stored pages and fetches nothing. Per-bucket TTLs are `cache.<bucket>.ttl` in the config.
- `spiderlint cache status` lists every bucket with entries, bytes, oldest and newest; `spiderlint cache purge [bucket] [--older-than 7d]` deletes; `spiderlint cache warm <url>` fills `robots` and `sitemaps` without crawling. The shape is `pf-cli cache status|warm|purge`, which the fleet already knows.
- The action persists its store through the forge’s cache keyed by job and `site` (`cache: false` turns it off), running the image as the runner’s uid so the cache step can read it; a CI run on an unchanged site is a run of `304`s.

## Configuration

Precedence: flags, then `SPIDERLINT_*` environment, then the `org.spiderlint`
subtree, then defaults — ignorelint’s ladder. Without `pf-cli` on `PATH`,
`--config spiderlint.yaml` accepts a plain file carrying the same subtree,
so outsiders need no projectfile.

```yaml
org:
  spiderlint:
    targets: [https://f.dbuho.me/]     # optional; the command-line urls win
    canonical-origin: https://dbuho.me # optional; the origin a staging twin’s pages are built for
    resolver: system                   # or 9.9.9.9,[2620:fe::fe]:53; the servers the crawl and the dns plugin ask
    resolve: []                        # host[:port]:address pins, as curl’s --resolve
    rules: [all]                       # optional; replaces every group's rules
    fetch: auto                        # auto | http | browser | adaptive
    browser: chromium                  # chromium | firefox | webkit
    scope: origin                      # origin | host | domain
    concurrency: 0                     # 0 = NUMPROCS
    rate: 0                            # requests per minute, 0 = unlimited
    max-pages: 0
    resources: { fetch: true, max-per-page: 200 }
    links: { exclude: [] }             # hosts, with their subdomains, whose links are never probed
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
      origins: { ttl: 24h }
      dns: { ttl: 60 }                 # a floor; the record TTL wins above it
      extractors: { ttl: 0 }           # 0 = until the body changes
    fail-on: error
    format: human
    plugins: []                        # explicit; nothing is auto-loaded from node_modules
    sources: []                        # <id>:<argument>, list:urls.txt crawls those URLs only
    images: { weight: 200000 }         # a plugin’s own key, checked against its schema once plugins load
    groups: { … }
    rulesets: { … }
    sites:                             # optional; one run and one store per site
      static:
        targets: [https://beta.dbuho.me/]
        canonical-origin: https://dbuho.me
      preview:
        targets: [https://f.dbuho.me/]
        fetch: browser
```

A top-level object key the core does not know belongs to the plugin of that name:
it is validated against the plugin’s `settings` schema, defaults filled in, once
plugins load, and one no loaded plugin claims is an unknown key. No flag or
environment variable mirrors it.

A `sites.<name>` entry takes every key above except `sites`, and each key it sets
replaces the shared one whole; a plugin key replaces only that plugin’s. Without a URL, `audit`, `crawl`, `lint`, `report`,
`groups` and `cache` run once per site, `--site` narrows the set, and the exit code
is the worst of the runs. Shared `targets` beside `sites` is a config error, and so
is `json` or `sarif` over more than one site, since each is one document. The action therefore audits one `site` per step, each with its own report paths and SARIF category.

The shape is registered in `projectfile/specification/spec/registry.yaml`
with a fragment under `spec/shapes/org.spiderlint.yaml` once v1 ships.

## CLI

```text
spiderlint audit  [url…]                  crawl + lint into the site’s store (--no-cache streams)
spiderlint crawl  [url…]                  accumulate only
spiderlint lint   [url…]                  rules over stored facts, no network
spiderlint report [url…]                  re-format stored findings
spiderlint facts  <url>                   one page’s facts document as JSON, the site document under `site`
spiderlint groups [url…]                  page count per group, unmatched pages
spiderlint rules [ruleset…]               every rule: severity here, scope, ruleset, docs
spiderlint presets                        shipped rulesets, rule count, used by a group
spiderlint explain <rule>                 severity, scope, facts read, expect, when, message, fix, docs
spiderlint cache status|purge|warm        every bucket: entries, bytes, age
```

Flags mirror the config keys (`--rules`, `--canonical-origin`, `--resolver`, `--resolve`, `--fetch`, `--browser`, `--scope`, `--concurrency`,
`--rate`, `--max-pages`, `--max-depth`, `--max-body-size`, `--include`, `--exclude`, `--source`, `--proxy`, `--no-robots`,
`--no-sitemap`, `--no-keepalive`, `--no-resources`, `--format`, `--fail-on`, `--unfold`, `--disabled-rules`,
`--error`, `--warning`, `--info`, `--site`, `--config`, `--resume`, `--no-cache`, `--refresh`, `--offline`).
Later: `--output`, `--fail-fast`, `--header`, `--cookie`, `--user-agent`, `--locale`. Results go to stdout, diagnostics to stderr; `human` and `--help` color on a TTY only; `NO_COLOR`, `FORCE_COLOR` and `--[no-]color` honoured.

## Plugins

```ts
export default definePlugin({
  name: 'html-validate',
  settings:   { type: 'object', properties: { … } },                          // JSON Schema of org.spiderlint.html-validate
  extractors: [{ id: 'htmlvalidate', async extract(page, body, live, context) {…} }], // facts land under page.htmlvalidate
  rules:      { 'html-validate/no-dup-id': (severity) => ({ meta, check }) }, // the built-ins’ shape
  presets:    { 'html-validate': { description, rules } },
  resources:  [{ id: 'images', types: ['image/png'], async extract(url, contentType, body) {…} }], // facts land under resources[].images
  formatters: { junit: (report, paint, isFull) => '…' },                         // --format junit
  sources:    [{ id: 'list', follow: false, async urls(argument, signal) {…} }], // sources: [list:urls.txt]
})
```

- Bundled plugins are always registered. `plugins` names the others: a path (`./`, `../`, `/`) from the working directory, else a package resolved beside spiderlint. Nothing is discovered from `node_modules`. A plugin redefining a rule, preset, extractor, format or source ID is a config error.
- An extractor runs on a page only when a rule of the page’s group reads a fact under its ID, as a `browser.*` rule forces Chromium. It sees every fetched page with its body and returns `undefined` to add nothing; one that throws logs a warning and leaves its key absent, so its rules skip.
- Extractor facts are stored with the page. `lint` and `--offline` run an extractor the stored facts lack against the stored body, so enabling a plugin’s rules needs no re-crawl.
- Plugin presets sit beside the shipped ones and list in `spiderlint presets`; `<plugin>:<variant>` names a variant (`html-validate:a11y`).
- An extractor with `mode: browser` gets the crawler’s live Playwright page as `live`, runs only on a rendered HTML page, and forces the browser crawl as a `browser.*` rule does. `lint` and `--offline` cannot backfill it from a stored body; a store lacking its facts warns once.
- `sites: [{ id, per: origin|host, timeout?, extract(subject, context) }]` runs once per origin (scheme, host, port) or hostname the crawl kept pages on, after the crawl, `NUMPROCS` subjects at a time, each abandoned after `timeout` (60 s). Facts land under `site.origins[<origin>].<id>` or `site.hosts[<host>].<id>`; `undefined` adds nothing, a throw or a timeout warns and leaves the key absent. `context` holds the subject’s `pages`, an abort `signal`, `address(host)` (the address a raw socket or external tool may connect to, through the run’s lookup, a private one refused unless `allowPrivate`), and `linked` when the subject is a host only linked or loaded, and `fetch(url, { method: GET|HEAD, headers, redirect: manual|follow })`: the spiderlint user agent, a 10 s timeout, one retry on a network error, `429` or `503`, a 1 MB body cap, every URL and followed hop on the subject’s host, and none that `robots.txt` disallows for `spiderlint` unless `robots` is off: that probe logs its URL at `info` and throws, `well-known` records the file as `disallowed`, and a subject rule whose path runs through it is skipped.
- A site extractor runs only when an enabled rule reads `site.origins.*.<id>` or `site.hosts.*.<id>`. Its facts persist with the site document and are reused from the `origins` bucket while fresh; `lint` and `--offline` cannot backfill one, and warn once when the stored site facts lack it.
- `origin` probes each origin: `GET /spiderlint-<uuid>` (logged at `info`, so an owner finds it in their access log), plain `http://<host>/`, `/` in four `Accept-Language`s, `/` once per coding (`identity`, `br`, `zstd`, `gzip`), and `/favicon.ico`. Rules: `origin/soft-404`, `origin/error-page` (HTML, not empty, no stack trace, no versioned `Server`), `origin/https-entry` (one `301` or `308` to `https://<host>/`; skipped on `.onion`), `origin/locale-redirect`, `origin/compression` (`info`: an HTML `/` over 1 KB not offered in all of `br`, `zstd` and `gzip`), `origin/favicon`. Preset `origin`; `recommended` and `all` carry it.
- `dns` runs four `per: host` extractors, `cached: false` so they skip the `origins` bucket and each answer lives in the `dns` bucket for its record TTL. They query `context.dns`: the `resolver` servers over UDP with TCP on truncation, `DO` and `AD` set, 3 s per try, 2 tries per server. IP literals and special-use or overlay names (`localhost`, `test`, `invalid`, `example`, `local`, `onion`, `i2p`, `alt`, `internal`, `home.arpa`) are never queried; the zone is the nearest name answering `SOA` at or below the registrable domain (`tldts`, private suffixes included). `dns` holds `zone`, `a`, `aaaa`, `cname`, `https` (RFC 9460, parsed by `crawl/svcb.ts`, `hintsMatch` where the target is the owner), `h3` (`record` vs `altSvc` of the host’s pages), `caa` (RFC 8659 climb to the registrable domain, `issuer` from the served certificate’s organisation through a CA map, absent when unknown), `dangling` (the last CNAME target when the chain ends in NXDOMAIN, else `false`; on a linked host `dns` holds only `cname` and `dangling`, and `dns/dangling-cname` is the one `linked` rule), and, facts only, `forSale` (the `_for-sale.<zone>` TXT strings) and `agents` (the `_agents.<zone>` SVCB records). `dnssec` holds `signed`, `ds`, `dnskey`, `ad`, `rrsig` (`expires`, `daysLeft`, `left` share of the validity window) and `nsec3`; `bogus` is present only when the resolver sets `AD` on the root SOA, otherwise one run-level warning. `nameservers` holds `servers` (each asked for the zone SOA directly, recursion off), `serials` and `networks` (distinct /24 and /48). `mail` holds `mx`, `spf` (the host’s `v=spf1` TXT records) and `dmarc` (`at`, `record`, and `policy`: `p` at the host, else `sp` or `p` at the registrable domain). Presets `dns` (17 rules), `dns:mail` (opt-in, for a name that sends and takes no mail: `null-mx`, `spf-none`, `dmarc-reject`) and `dns:core` (`https-record`, `caa`, `caa-issuer`, `dangling-cname`, `dnssec`, `dnssec-bogus`, which skip `nameservers`); `recommended` carries `dns:core`.
- `resources: [{ id, types, extract(url, contentType, body) }]` reads the body of every fetched `2xx` resource whose content type starts with one of `types`, as bytes, during its one `GET`; a body cut at `max-body-size` is read by none. It runs only when an enabled rule reads `resources.<id>`, facts land under `<id>` on every page’s entry for that URL, and they are stored with the response in the `resources` bucket, so a fresh or `304` answer reuses them; an entry an active extractor never read is fetched again in full. `undefined` adds nothing; a throw warns and leaves the key absent.
- An extractor with `cost: expensive` runs on at most the group’s `sample` pages; `cheap`, the default, on every page.
- `settings` is the JSON Schema of `org.spiderlint.<name>`; each rule the plugin makes gets the validated value, its defaults filled in, as `make(severity, settings)`. A plugin named as a core key is a config error.
- `formatters` maps a format name to `(report, paint, isFull) => string`. The built-in formats are the bundled `report` plugin’s, so `--format` resolves every name the same way, and an unknown name lists every loaded one.
- `sources` entries are `<id>:<argument>`; each source’s URLs join the seeds before the store is chosen, so they name it as seeds do. A source with `follow: false` makes the seeds the whole frontier: no link or sitemap URL joins them, while sitemaps are still read for their facts. A throw or 60 s without an answer is a config error.
- `list` is the bundled source: one URL per line of a file (`-` for stdin), empty lines and `#` comments skipped, `follow: false`.
- Page and resource extractor facts are kept in the `extractors` bucket by ID, version, URL and a digest of the content type and body, so an unchanged page or resource is never analysed twice. A bundled extractor carries spiderlint’s version, a plugin one without `version` is never cached, and `cached: false` opts out an extractor that reads more than its body: `axe` (rendered styles), `feeds` (the `Link` header), `markdown` (it fetches).
- `html-validate` runs html-validate’s `recommended` and `document` presets. `require-sri` is narrowed to cross-origin scripts, which `resources/sri` also judges. A rendered DOM is Chromium’s serialisation, so browser mode adds html-validate’s `browser` preset. A body truncated at `max-body-size` is skipped: its cut-off elements would all fail. Facts are `htmlvalidate.messages[]` (`rule`, `message`, `severity`, `line`, `column`, `offset`, `size`, `selector`, `source` — the tag at the offset — and `context`); each html-validate rule is the rule `html-validate/<id>`, one finding per distinct message per page with its locations as the value and `line:column selector <tag>` as `locations`. Presets: `html-validate`, `html-validate:standard`, `html-validate:a11y`, `html-validate:document`; `all` carries them, `recommended` does not.
- `htmlhint` runs htmlhint’s default ruleset and the rules it ships off that judge a defect rather than a house style (no quote, indent, attribute order or inline-script policy); a truncated body is skipped. Facts are `htmlhint.messages[]` (`rule`, `type`, `message`, `line`, `column`, `source` — htmlhint’s `raw` tag); each htmlhint rule is the rule `htmlhint/<id>` at the level htmlhint reports it, shaped as `html-validate`’s through `messages.ts`. Presets: `htmlhint` (the default ruleset), `htmlhint:extra` (the rest); `all` carries them, `recommended` does not.
- `axe` (`cost: expensive`) runs axe-core through `@axe-core/playwright` in the crawler’s own rendered page (pa11y would launch a second browser), with axe’s default rule set: no experimental, AAA or obsolete rules. Facts are `axe.version`, `axe.violations[]` and `axe.incomplete[]` (`rule`, `impact`, `tags`, `description`, `help`, `error`, and `nodes[]` with `target`, `html`, `xpath`, `ancestry`, `impact`, `summary` and the `any`/`all`/`none` checks, each with `message`, `data` and `related` elements); each axe rule is the rule `axe/<id>`, one finding per violated rule per page with its impact and elements as the value and `selector <tag>, related: …` as `locations`. Presets: `axe` (WCAG A and AA rules as errors, best practices as warnings), `axe:wcag`, `axe:best-practice`; `all` carries them, `recommended` does not.
- `images` reads JPEG, PNG, GIF, WebP, AVIF and SVG through `sharp` (libvips, one thread per image, 50 MP input cap, 30 s per operation), once per body digest in a run, so one image under several URLs is measured once. Facts are `images.format`, `bytes`, `width`, `height`, `animated` and `encoded` — the bytes after re-encoding to its own format (`same`), and a legacy format to `webp` and `avif` — at JPEG and WebP quality 80, AVIF 50 and palette PNG; an SVG is never rasterised, its `same` is SVGO’s output. `text` reads style sheets and scripts into `bytes` and `minified` (esbuild), and a style sheet’s `fontFaces` (`family`, `display`); `fonts` sniffs a font’s `format` from its first bytes. `imageLayout` (`mode: browser`, `cost: expensive`) reads the viewport and each `<img>` box, its document `top`, `natural` width and `loading`, in the crawler’s page at its default desktop viewport. Rules: `images/modern-format` and `images/recompress` (a saving of 20 % and 10 kB), `images/weight` (above 200 kB), all `scope: site` keyed by image URL; `images/dimensions` (`<img>` without `width` and `height`) and `images/oversized` (intrinsic width above twice the `width` attribute, `srcset` exempt), page rules with the offending `<img>` as `locations`. Preset `images`; `recommended` and `all` carry it. `images:assets`: `images/font-format` (not WOFF2), `images/font-display` (`@font-face` with no `font-display`, or `auto` or `block`) and `images/minify` (the same saving bounds), keyed by asset URL. `images:live`: `images/lazy-below-fold` (an eager `<img>` starting below the first viewport), `images/lazy-above-fold` (a lazy one inside it) and `images/rendered-oversize` (natural width above twice the rendered width × device pixel ratio), hidden images never judged. Neither is in `recommended` before a real-site audit. `org.spiderlint.images` sets `saving: { share, bytes }`, `weight` and `oversize`.
- `well-known` runs two `per: origin` extractors, each file one `GET` following same-host redirects. `wellKnown` probes `security.txt`, `change-password`, `gpc.json`, `api-catalog`, `openid-configuration`, `oauth-authorization-server`, `oauth-protected-resource`, `webauthn`, `apple-app-site-association`, `assetlinks.json`, `nodeinfo` (and the first document it links on the host), `traffic-advice`, `webfinger` (fact only) and `tdmrep.json` under `/.well-known/`; `agents` probes `/llms.txt` (then `/.well-known/llms.txt`), `/llms-full.txt`, `agent-card.json`, `ai-catalog.json`, `mcp/server-card.json`, `agent-skills/index.json`, `/okf/index.md` and `/schemamap.xml`. Each file is `{url, status, contentType, redirects, present, bytes, errors[], fields}`: `present` is a `2xx` that is not `text/html` (for `change-password` any `2xx` or off-host redirect), and only a present file is checked, so a soft 404 reads as absent. `wellKnown.changePassword.required` is set when a crawled page carries `input[type=password]`, and `wellKnown.unregistered` lists `/.well-known/` suffixes the pages link on the origin that the vendored IANA list (`well-known-registry.ts`, refreshed by hand) lacks. `security.txt` adds `daysLeft` from `Expires`. Rules: `well-known/security-txt`, `security-txt-valid`, `security-txt-expires` (0–366 days), `change-password`, `registered` (`info`), and one `well-known/<file>` per checked file reading its `errors`; the agent rules `llms-txt`, `llms-txt-valid` (one H1 first, links answering `2xx`: crawled pages from the store, any other through `context.link`, the cached `probes` answer `links/broken-external` shares) and the drafts are `info`. The `markdown` page extractor (`cost: expensive`, so sampled pages only) asks a crawled `2xx` HTML page for its Markdown twin, the advertised `rel=alternate type=text/markdown` else `<url>.md` (a directory tries the stripped sibling first, `/posts.md`, then `/posts/index.html.md`), and for itself with `Accept: text/markdown`, through the page context’s host-bound `fetch`; a backfilled page has no context and gets none. `well-known/markdown-source` (`info`) reads it. Presets `well-known`, `well-known:security` and `agents`; `all` carries them, `recommended` does not.
- `feeds` reads RSS, Atom (saxes, so a malformed body is an error, not a guess) and JSON Feed pages into `feed: { format, error, self, hubs, items, unidentified }`, the `Link` header adding a self or hub the body lacks. `structured-data` reads Microdata and RDFa into `structureddata: { microdata, rdfa }` as JSON-LD-shaped nodes, so every rule judges all three syntaxes: JSON-LD blocks that do not parse, a hand-kept required-property table per rich-result type, `BreadcrumbList` items the crawl found non-2xx or redirecting, page and article nodes whose `url` is not the canonical or whose name is in neither title, bare `@id` references to a blank node or fragment that the crawled page they point into (or its canonical-origin twin) never defines, one `@id` typed two ways or one named entity under two `@id`s across the site, terms schema.org marks `supersededBy` (`schema-registry.ts`, generated from the vocabulary release), and dates that are not ISO 8601, run backwards, disagree with `article:published_time` or are missing on an article. `manifest` reads `resources[kind=manifest]` bodies for `name`, `start_url`, `display`, and 192, 512 and maskable icons. `link-text` matches accessible link names against a reviewed phrase list per primary language subtag (`en`, `es`, `uk`); any other language adds no facts. `markup` holds `markup/lang-switcher` (an anchor to a foreign-language `hreflang` alternate declares its language; same-language navigation is exempt), `markup/captions` (a muted `<video>` without controls is decorative and exempt) and `markup/input-type` (over `html.inputs`). `trackers` is one site finding per vendor in a hand-kept host list, at `info`. Each ships a same-named preset; none is in `recommended` before a real-site audit.
- `tls-probe` runs one `per: origin` extractor, `tlsProbe`, on each `https:` origin through `openssl s_client` (installed in the image; missing, it warns once and adds nothing), connecting to `context.address`, the guarded address of the host, since the tool resolves nothing itself. Facts: `address`, `legacy` (TLS 1.0 and 1.1 when forced alone at `SECLEVEL=0` and accepted), `chain` (`sent`, and `complete` when each certificate is issued by the next and the last is a root or issued by a trusted one), `ocsp` (`responder` from the leaf’s AIA, `stapled`) and `earlyData` (a TLS 1.3 session resumed with a `HEAD /` as early data, accepted). Rules `tls-probe/legacy-protocols`, `chain-complete`, `ocsp-stapling` (`info`, only where the leaf names a responder) and `early-data` (`info`, since early data is replayable). Preset `tls-probe`; `all` carries it, `recommended` does not.
- A live extractor that changes page state (key presses, emulated media) opens its own page in the crawler’s context through `withPage` in `plugins/visit.ts`, so the crawler’s page stays as rendered for `axe` and every read-only extractor, and extractor order never matters.
- `keyboard` (`cost: expensive`) presses Tab through a fresh page with transitions stilled, at most twice per candidate plus ten. Each stop records `visible` (the element, its pseudo-elements, parent or first ten children look different focused than blurred, an outline counted only when its style is not `none`), `forced` (the same comparison on a visible stop refocused from script once the walk ends and forced colours are emulated on the same page) and `obscuredBy` (a fixed or sticky element at the focused box’s centre). The walk ends `complete` when focus returns to its first stop or leaves the page; `trap` is where focus rests for 20 presses or cycles back to a later stop, and `unreached` lists shown candidates Tab never reached, a radio group reached through any radio. Rules `keyboard/tab-walk`, `focus-visible`, `forced-focus`, `focus-obscured` and `skip-link` (`info`: the first stop is inside `<main>` or a same-page link to it). Preset `keyboard`.
- `live` (`cost: expensive`) loads a fresh page under `prefers-reduced-motion: reduce` and `prefers-color-scheme: dark` and reads text axe’s `color-contrast` finds too faint, only when the page claims dark support (`color-scheme` meta or root style naming `dark`, or a `prefers-color-scheme: dark` rule in a readable sheet), animations still running that are endless or longer than 5 s, autoplaying videos, `<div>` and `<span>` elements with their own click listener and no role (CDP `DOMDebugger.getEventListeners`, Chromium only, 200 at most), form fields under 16 px at the desktop viewport, then, on the same page with forced colours emulated, `forced.icons` (links and buttons with no visible text, no image or SVG and no paint that survives: a gradient is dropped, a mask filled with the forced background vanishes, a `url()` background stays) and `forced.optOut` (roots of `forced-color-adjust: none` holding visible text, with their colours), 50 of each at most, and, facts only, service worker registrations and WebMCP tools (`navigator.modelContextTesting.listTools()`, where a polyfill defines `navigator.modelContext`). `contrast.claimed` is a `prefers-contrast: more` (or bare `prefers-contrast`) rule in a readable sheet; a claiming page is loaded once more under `contrast: more` for `contrast.faint`, axe’s `color-contrast-enhanced` (7:1). Rules `live/reduced-motion`, `dark-contrast`, `contrast-enhanced`, `forced-icons`, `click-listener`, `input-font-size` (`info`), `contrast-more` (`info`: nothing answers the preference) and `forced-opt-out` (`info`). Preset `live`. Reduced transparency is not judged: Playwright cannot emulate it and no level of it is a defect; reduced data is not judged: no shipping browser sends it. No BFCache check: Playwright launches Chromium with the back/forward cache disabled and the headless shell disables it again, so only `no-store` shows, which the header already says.
- `lighthouse` (`cost: expensive`, `debugging: true`) runs Lighthouse’s default mobile audit in a new tab of the crawler’s own Chromium, reached through its DevTools port, so pins, resolver and proxy carry over. `debugging` makes the crawl open that port on loopback, one free port per browser launch, and `debuggingPort(live)` reads it back; Firefox and WebKit have none and add no facts. Facts are `version`, `formFactor`, `scores` by category and `vitals` (`lcp`, `cls`, `tbt`, `fcp`, `si`, `ttfb`), which also answer lab Core Web Vitals. Rules: each score at least 0.9 and LCP, CLS, TBT and FCP within Lighthouse’s good bound, declarative so a group’s ruleset overrides the threshold. Runs queue one at a time per process, since Lighthouse’s marks are process-global and Chromium traces once; with a raised `concurrency` they still overlap the crawl, so a score reads worse than a lone run. Preset `lighthouse`; none of the three is in `recommended`.
- `linkinator` is not wrapped: internal links are answered from the store and external ones by rate-limited `HEAD` probes with a per-host cache.

## Concurrency and limits

- Crawl: Crawlee’s autoscaled pool, `maxConcurrency` = `NUMPROCS` by default, browser mode halves it, and renders one page at a time when an expensive browser extractor runs, trading speed for memory; `concurrency` sets it as given, and sizes the resource, link probe and site extractor pools. `maxRequestsPerMinute` from `rate`, which also spaces every robots, sitemap, resource and probe request after it; `sameDomainDelaySecs` from `Crawl-delay`. Two crawlers side by side split `rate` and each wait twice the delay, so the site sees the pace one crawler would keep.
- Lint from store runs extractors and rules inline, in the one process.
- Retries: `maxRequestRetries: 3` with Crawlee’s backoff; `429` and `503` honour `Retry-After`. `retryOnBlocked` stays off — evading bot protection on someone else’s site is not this tool’s job.
- Timeouts: `requestHandlerTimeoutSecs` 60, navigation 30. Later: `--profile tor` raises both, drops concurrency to 4, and disables adaptive detection.
- Keep-alive is on; `--no-keepalive` trades connection reuse for one TLS observation per page.

## Tor, I2P, unusual hosts

- `--proxy socks5h://127.0.0.1:9050` — the `h` is mandatory so `.onion` names resolve inside Tor, never on the host. I2P is `--proxy http://127.0.0.1:4444`.
- One proxy carries every request of the run: both crawlers through Crawlee’s `proxyConfiguration`, robots, sitemaps, resources and probes through Node’s global proxy agents. `got-scraping` speaks HTTP proxies only, so a `socks*` proxy sits behind a loopback `proxy-chain` bridge, which resolves names inside the proxy. `http.remote` is dropped, since it would name the proxy. The `dns` plugin’s extractors query the resolver directly, so a proxied run skips them with one warning. A proxy and `allowPrivate: false` exclude each other: the address guard cannot see what the proxy connects to.
- A split-horizon or staging name: `resolver` other than `system` answers every crawl lookup, and `resolve` pins one name to an address, as curl’s `--resolve` does; the port curl’s form carries is ignored, since a lookup never sees it. The run swaps `dns.lookup` while its network is open, so got, `fetch`, probes and TLS handshakes all resolve through it, `localhost` stays the system’s, and a name the resolver has no address for fails as `ENOTFOUND`. Chromium gets `--host-resolver-rules`: every pin, and each seed host as the resolver answers it before launch; any other name it resolves itself, and Firefox and WebKit get neither. A proxy resolves inside itself, so a proxied run ignores both with one warning.
- No assumption is baked in that a site has TLS, resolvable DNS, a sitemap, or answers in under a second. Every such property is a fact a rule may require, guarded by `when`.
- `Onion-Location` is captured as a header fact for the `i18n`/`redirects` presets to reason about later.

## Security

- User agent identifies the tool: `spiderlint/<version> (+https://kiota.ch/damian-buho/spiderlint)` on every page, resource and sitemap request, and `robots.txt` groups are matched for `spiderlint`. spiderlint fetches `robots.txt` and the sitemap candidates itself, so they carry it too.
- No credential is sent. Later, a static `--header` / `--cookie` is redacted from logs and the store and never appears in findings.
- Scope restricts what is fetched; off-scope links are probed with `HEAD`, or `GET` when `HEAD` is refused, through the address guard.
- DNS queries go to the configured `resolver` only, never a default public one; the address guard does not apply to them. With `allowPrivate: false` a query naming a server directly is refused, so `serve` cannot be steered at an internal authoritative server.
- Site and page extractor probes send `GET` or `HEAD` only and never leave their subject’s host; `context.link` alone reaches other hosts, as the off-scope link probe above. With `allowPrivate: false`, which `serve` is to set, each socket connects only to an address its guarded lookup checked, refusing loopback, private, link-local, CGNAT and unique-local ranges; the CLI allows them, since it audits its owner’s staging hosts.
- `--no-robots` warns; `retryOnBlocked` is never enabled.
- Plugins load by explicit name only. Chromium runs as the `b19` user, never root. Its DevTools port opens on loopback only while a `debugging` extractor is active.
- The store can hold private staging pages; it lives owner-only in the user cache, never beside the project, and its path is logged on every run.

## Observability

- `pino` logs to stderr, `--log-level` (`info` default), JSON with `SPIDERLINT_LOG_FORMAT=json`. Otherwise each entry is one line: message, URL, error; its other fields show only when it has neither, or at `debug`. Crawlee’s own log is bridged into the same stream.
- When every seed shares one origin, that origin is logged once and every logged URL under it prints as its path; other origins, and runs with mixed-origin seeds, stay absolute. `human` does the same with the origin every page shares, printed once on top; `json`, `sarif` and the store always carry absolute URLs.
- Every decision logs its variables: group assignment (`url`, `group`, `matched`), rule skip (`rule`, `when`, `actual`), fold (`group`, `rule`, `failed`, `applicable`, `ratio`), sampling (`group`, `extractor`, `taken`, `cap`), robots skip (`url`, `rule`).
- The run summary is a fact document too: pages, bytes, duration, per-group counts, per-status counts, `findings` per severity counted before folding (so `--unfold` changes no total), distinct `rules` run, `byRule` (findings per severity for every rule run, `{}` for a clean one), `checks`, `rating`, `crawlHash` (the crawl-shaping options), `previous` (the last stored run’s `byRule` summed over this run’s rules, when it ran every one of them with the same `crawlHash`, which `human` prints as a signed change per severity) and `cost` — browser launches, the pages they rendered and their TLS probes, plain HTTP fetches and revalidations, resource requests, cache hits and network-log answers, runs per extractor and the ones the `extractors` bucket answered — printed by `human` as one labelled row per value, embedded in `json` and `sarif` `invocations`.
- `human` numbers keep the locale’s digits and decimal mark but group with a narrow no-break space (SI), never a dot or comma; bytes take the largest unit they reach.
- `human` prints unfolded page findings that share severity, rule and message once, with one page per line under them; `json` and `sarif` keep one finding per page.

## i18n

- Finding messages, `human` output and `--help` are English. Later: `en`, `es`, `uk` through `gettext-parser`, as textlint-server does, selected by `--locale` and `LANG`.
- Rule IDs, fact paths and config keys are never translated.
- Docs are typographic (`’`, `…`); anything copied into generated docs (`description:` fields, help text) follows.

## Repository layout

```text
src/
├── cli.ts              # argument parsing, exit codes
├── index.ts            # library API: audit(), crawl(), lint(), report()
├── config/             # pf-cli reader, plain-file reader, schema, precedence
├── crawl/              # Crawlee adapters (http, browser), frontier, robots, sitemap, scope, proxy, probes, DNS
├── facts/              # facts types and extractors
├── groups/             # matcher, assignment, sampling
├── rules/              # Rule interface, declarative compiler, scopes
├── fold/               # saturation folding
├── cache/              # buckets, TTL, RFC 9111 freshness, atomic writes, locks
├── store/              # the pages bucket: Crawlee storage wrapper, manifest, redaction
├── report/             # formatters, bundled as the `report` plugin
└── plugins/            # contract, registry, bundled html-validate, htmlhint, axe, keyboard, live, lighthouse, origin, dns, tls-probe, images, well-known, feeds, structured-data, manifest, link-text, markup, trackers and list
presets/                # recommended.yaml, seo.yaml, security-headers.yaml, …
tests/                  # node:test; fixtures/site/ is a static multi-template site served locally
docs/                   # features.d/, es/, uk/
.container/             # image assets, as ignorelint
action.yaml             # composite action: one audit into a runner-side store, SARIF and a step summary from it
.scripts/action/        # the action’s steps
projectfile.yaml
```

## Build and CI

- `B19_NODE_SERIES: 26` under `org.projectfile.build.args` picks the series; the Dockerfile `ARG` default is only the fallback name.
- `projectfile.yaml` includes `.makefile/b19/ci.yaml`, `.makefile/b19/images/node.yaml`, `.makefile/library/languages/node.yaml`, and the `damian-buho/metadata` include plus the `forge/github.yaml`, `forge/codeberg.yaml`, `registry/ghcr.yaml` fragments — copy ignorelint’s block, swap the language.
- `org.projectfile.image.org: damian-buho`, `flatpath: ${name}`, `sinks.ghcr.selfref` — the account-is-org shape every personal image carries.
- `build.d/user/post/700-install-chromium.sh` installs the headless shell of the pinned `playwright` (`--only-shell`: headless runs never launch the full browser) into `PLAYWRIGHT_BROWSERS_PATH`; nothing downloads at runtime. Its libraries are curated in `.container/root/deps/common.apt.deps` from Playwright’s own per-distribution list, not `--with-deps`.
- `pf-cli` is copied from `PF_CLI_IMAGE`, the fleet’s `org.projectfile.images` declaration named in `build.args`, so the image and the action read a mounted `projectfile.yaml`.
- Self-test in `test.d/`: audit the bundled fixture site served from inside the container and expect the known findings, once over http and once in Chromium with its config read from a `projectfile.yaml` through `pf-cli`.
- `make` runs the m6e gates; lint, format, audit, outdated checks and `npm-test` (under `source-is-tested`) come from the node fragment. `NODE_TOOL_IMAGE` follows `B19_NODE_SERIES`, the same series as the base image.

## Testing

- `node --test --experimental-strip-types tests/**/*.test.ts`, no other runner.
- `tests/fixtures/site/` is a static site with three templates (post, tag, app), `robots.txt`, `sitemap.xml` naming an unlinked `/orphan`, an XML feed, a head-only Atom feed and a web manifest, a `/private/` robots disallow, a `/tmp/` path for `--exclude` and a dead `/missing` link, served by `tests/fixtures/server.ts` on an ephemeral port with an HTML 404 for anything else. Every rule has a passing and a failing page there; the post template is missing `<h1>` on every page so folding is exercised end-to-end. Site rules fail on `tests/fixtures/origin.ts`, a `soft` and a `trace` origin. Fixture files carry inline SPDX comments, no `.license` sidecars.
- Every formatter is tested for its shape; SARIF against the full SARIF 2.1.0 schema, `tests/fixtures/sarif-2.1.0.schema.json`, vendored from `microsoft/sarif-sdk` at a pinned commit under its MIT licence, since the OASIS original carries no SPDX licence; `format` keywords are not checked, which would need `ajv-formats`.
- No test reaches the network. External-link probes point at the same local server.
- `tests/browser.test.ts` skips its Chromium suite when a launch fails, which it does in the node tool image `npm-test` runs in; the image self-test is where Chromium is proven.

## Later

- `--baseline previous.json`: report only new findings, SARIF `baselineState`.
- Template fingerprinting: hash the DOM skeleton (tag paths, no text) per page; cluster; `spiderlint groups --suggest` proposes groups, and `match: [fingerprint:<hash>]` groups pages whose URLs do not reveal their template.
- String assertion sugar (`title.length in 30..60`) compiling to the same JSON Schema, only if the schema form proves clumsy in practice.
- `tls-probe` keyed by `(origin, remote.address)` instead of the one address the lookup answers, so two backends behind one name get two probes; weak cipher suites.
- Screenshot per sampled page in browser mode; visual diff against baseline.
- Multi-arch once `b19/node` is.

## Open decisions

- Fold threshold `0.8` and minimum `3` are guesses. The fixture site and the first audit of f.dbuho.me decide.
