<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

[Español](es/FEATURES.md) · [Українська](uk/FEATURES.md)

# Features

## Project Features

### Accessibility checked from every side

- Every axe-core rule for WCAG 2.2 A and AA, and its best practices, runs in the rendered page, so defects that scripts introduce are caught too.
- The markup of every page, not a sample, is checked for the accessibility defects html-validate sees without a browser: missing labels, skipped heading levels, missing alt text.
- Keyboard use is tried on a few pages per template: Tab must reach every control without a trap, focus must show and stay uncovered, a skip link must come first, and click handlers on plain elements are reported.
- Visitor settings are honoured: animations stop under reduced motion, text stays readable in the dark scheme and the higher contrast a page offers, focus and icons survive Windows high contrast, and form fields are large enough that phones do not zoom.

### Client-rendered pages audited as visitors see them

- A page whose tags, links or content appear only after its scripts run is rendered in a real browser, so what gets linted is what search engines and visitors see.
- Only the sections that need a browser are rendered; the rest of the site is crawled over plain HTTP at full speed in the same run, and a section that renders its tags client-side can be detected on its own.
- Console errors, load timings and every resource a page loads at runtime become facts that rules can check.
- What a page loses without JavaScript — its title, description, canonical link, heading, internal links or text — is reported, from its raw HTML against its rendered page.

### CSS checked as browsers read it

- Style sheets and inline CSS are parsed for what browsers silently drop: syntax errors that lose a whole rule, misspelled properties and values outside a property’s grammar.
- Each defect names its line and column, in the style sheet or in the page that holds the inline block.
- A style sheet every page loads is one finding with the pages that use it, and inline CSS folds per template.
- Features the project’s declared browsers lack are listed with the browsers that lack them, while code behind `@supports` is left alone.
- Vendor prefixes and old browser hacks are never reported, and the check needs no Java validator.

### The DNS behind every crawled host

- Missing HTTPS records are reported, so a first visit can start on HTTP/3 without a round trip to discover it.
- CAA is judged against the certificate the site actually serves, so a CA that CAA forbids is caught before it fails a renewal.
- DNSSEC is checked end-to-end: an unsigned zone, weak algorithms, stalled re-signing, and a signed zone that validating resolvers reject.
- Name servers are asked directly and every other query goes only to the resolver you name, so a lame server or a zone out of sync shows, and a link to a subdomain whose CNAME points nowhere is flagged as a takeover risk.
- Each name is judged by what its records say it does with mail: one that takes none is held to a null MX, a deny-all SPF and a DMARC reject policy, one that does to a single closed SPF record and an enforced DMARC policy, so a half-finished setup shows either way.
- The domain registration is read from its registry, so a renewal that is days away, a missing transfer lock or a registry naming other name servers than the zone shows before the domain lapses or is taken.
- Every address is traced to the network that routes it, so a route that RPKI-enforcing networks drop, a mail server with no matching reverse DNS, or a site and its name servers all behind one provider come to light.
- SSH host key fingerprints published in DNS are compared with the keys the SSH server actually presents, so a record left stale by a key rotation is caught before it makes clients refuse to connect, and one no client may trust without DNSSEC is named.

### Feeds checked the way readers see them

- RSS, Atom and JSON feeds are checked against their own specifications: required fields, dates readers can parse, identifiers that never repeat or change, so subscribers never see an old post as new.
- Item content is read as a reader renders it: unrendered Markdown or MDX, template placeholders, relative links and images, double escaping and markup readers strip are each named with the item they sit in.
- Every item is compared with the page it links: a link that fails or redirects, a title, date or language that disagrees, a canonical URL the feed bypasses.
- How the feed is served for polling is judged too: its type and encoding, conditional requests, caching, size, and an XSL style sheet Chrome no longer applies.
- Podcast feeds can be checked for what directories require, as an opt-in: the iTunes channel and episode tags, a stable Podcasting 2.0 GUID, a `podcast:locked` policy, and artwork Apple accepts — square JPEG or PNG, 1400–3000 px per side.
- Every enclosure is answered once with HEAD and judged against its declaration: reachability, byte and type agreement, and byte-range support, which Apple requires of episode hosts.
- A declared WebSub hub can be probed with a discovery request, opt-in only.
- A podcast directory requires RSS 2.0 with the iTunes and content namespaces declared, a unique enclosure with URL, length and type per episode, a GUID per episode that never changes, and RFC 2822 dates.

### One finding per template, not per page

- Pages are grouped by URL pattern, so a defect every post shares is reported once for the post template, with sample pages; costly checks such as accessibility run on only a few pages of each template.
- A group whose pages disagree on a rule gets an advisory that it likely mixes two templates.
- Values that must be unique across the site, such as titles and descriptions, are reported once per duplicate with every URL that shares it.
- Every run ends with the number of checks passed and a grade from S to F, so sites and releases compare at a glance.

### Icons fetched and measured

- Every icon the pages, the web app manifest and `browserconfig.xml` name is downloaded once and measured, so an icon that is really smaller than it claims, or another format, is a finding.
- The favicon, the Apple touch icon, the SVG icon, the Safari pinned tab and the Windows tiles are each judged on what the platform really asks for, such as an opaque 180×180 PNG for iOS.
- A page that links no Apple touch icon is checked against the path iOS requests anyway.

### Image weight measured, not estimated

- Every image the site loads is re-encoded once, and the bytes AVIF, WebP or a tighter encode of its own format would save are reported.
- Each heavy image is one finding with the pages that use it, across the whole site rather than a sample of pages.
- Images that ship far more pixels than they display, or have no width and height to hold their place, are flagged per template.
- Measurements are cached with the image, so a re-run measures only what changed.
- Fonts, style sheets and scripts are weighed the same way: fonts that are not WOFF2, font faces that hide text while they load, and bytes minification would save.

### The site measured as a whole

- Weight, requests, timings and carbon of every page add up to site-wide figures: median, 95th percentile, extremes and totals, even when no page breaks a budget.
- A page far slower or heavier than the rest, or served differently from nearly every other page, is pointed out, and the same crawl always gives the same answer.
- Every fact about every page exports to a spreadsheet, with no second crawl.

### Dead links, on the site and off it

- A link that leads nowhere, to this site or to another one, is one finding listing every page that carries it.
- Links to other sites are checked once per run and remembered for a week, so a re-run sends them nothing.
- A site that only asks the checker to slow down is not reported as dead.
- Feeds a page advertises in its head are crawled and checked too, even when no link points to them.
- Internal links marked nofollow are found, links to paid or user content can be held to a rel policy the owner declares, and a profile the site claims as its own that does not link back, as Mastodon verification requires, is reported.

### Mail authentication of every domain it crawls

- A domain that takes or sends mail is found on its own, and one that does neither keeps the no-mail checks, so nobody has to say which kind it is.
- SPF is walked through every include the way receivers walk it, so a record that silently fails on too many lookups or a missing include shows before mail bounces.
- DMARC, DKIM and MX are checked for the faults receivers punish: several policies, report addresses that refuse the reports, short keys, keys left in testing, and mail servers behind a CNAME.
- MTA-STS, TLS reporting and BIMI are read end-to-end, so a policy that leaves a mail server out or a logo no mail client will show is caught.
- DANE and a live STARTTLS check of each mail server are there when you turn them on.

### Each origin checked once, beyond its pages

- A missing page is requested on purpose, so a soft 404, or an error page that leaks a stack trace or a server version, is a finding.
- Every way in — http or https, with or without `www.`, at the root or deep in the site — must land on one canonical origin in a permanent redirect that keeps the path, and the home page must not redirect visitors by their language.
- Cross-domain policy files that let any other site read pages with the visitor’s session are reported.
- Plugins add their own once-per-origin or once-per-host checks; their results are reused between runs, and their requests never leave the host they check.

### Structured data and markup checked on every page

- Structured data in JSON-LD, Microdata or RDFa is reported when it does not parse, lacks what its rich result needs, contradicts the page or the rest of the site, uses retired schema.org terms or malformed or contradictory dates, or has breadcrumbs leading to missing or moved pages.
- The web app manifest is checked for what installing the site needs: a name, a start page, a display mode and icons in the sizes phones ask for.
- Vague link text such as “click here” is found in the page’s own language, and a language without a reviewed list is skipped rather than judged in English.

### Speed problems found without a browser

- Every text response must be compressed with Brotli, Zstandard or gzip, and every page must be cacheable, revalidatable and eligible for the back/forward cache.
- A server still on HTTP/1.1, one that does not advertise HTTP/3, and a certificate whose RSA key makes every handshake larger than an EC key would are reported.
- Scripts and style sheets that block the first render, a lazy loaded first image, and images with no size to hold their place are found in the HTML of every page.
- Rendered pages get Lighthouse performance, accessibility, best-practices and SEO scores and lab LCP, CLS, TBT and FCP, on a sample of each template.

### Privacy before consent

- Third-party and tracking cookies set on the first load, before the visitor touches anything, are reported, and so is web storage written the same way.
- Cookies that scripts write are held to the same expectations as the cookies a server sets.
- The analytics and advertising vendors a site loads are listed in one inventory, so what the privacy policy must name is known.
- A page with no link to its privacy policy is reported.

### Sites on any network, crawled politely

- Onion services and I2P sites are audited with one setting, through the local Tor or I2P proxy, at the pace and timeouts those networks need.
- Every request of the plain and the browser crawl can go through an HTTP, HTTPS or SOCKS proxy, including SOCKS proxies that resolve hostnames themselves.
- A server that answers “too many requests” or “unavailable” is retried with backoff and its `Retry-After` honoured, and a cap on requests per minute keeps the crawl within what a site tolerates.
- robots.txt is obeyed unless you say otherwise.

### Reports for people, pipelines and coding agents

- Findings come as text, JSON, SARIF, Checkstyle, CSV or an HTML report, and a stored crawl is re-formatted without fetching the site again.
- Each finding can say how to fix it for the site at hand, the exact record, header or tag with the site’s own names filled in, and code scanning shows the same guidance beside every alert.
- The agent format turns findings into fix prompts for a coding agent, ordered by severity and by how many pages each fix clears.
- A CI action audits a site on every push, fails the job at the severity you choose, uploads SARIF to code scanning, and caches the crawl so an unchanged site costs almost nothing to re-audit.
- Exit codes tell findings apart from a bad configuration and from a site that could not be reached, so a pipeline knows which one failed.

### Page dependencies fetched once

- Scripts, style sheets, images and frames the pages load are fetched once per run, whatever their origin.
- A broken or insecure dependency is one finding listing the pages that use it, not one finding per page.
- Cross-origin scripts without integrity hashes and plain-HTTP resources on HTTPS pages are reported.
- The web app manifest is fetched and judged like any other dependency.

### robots.txt read the way crawlers read it

- A robots.txt that shuts every crawler out of the whole site is reported, since it takes the site out of search results.
- The AI crawlers it names are listed by purpose — training, search or user fetch — with the ones it shuts out and the names no vendor sends any more.
- Content Signals that say something other than yes or no to search, AI input or AI training are reported.

### Over 500 rules, and new ones written as data

- A rule is a fact path plus a JSON Schema, so a new check needs no code.
- Bundled presets cover search, security headers, TLS, DNS, cookies, performance, accessibility, privacy, sustainability, links, redirects, sitemaps, robots.txt, well-known files and files for AI agents.
- Each URL group runs its own rule sets, and any rule’s severity can be changed or switched off from the command line, the environment or the projectfile.
- axe-core, html-validate and htmlhint run inside the same crawl, each of their checks a rule you can tune or switch off like any other, and Lighthouse scores join them on rendered pages.
- Plugins add their own facts, rules, presets, report formats and URL sources beside the bundled ones, and a plain list of URLs can be audited on its own.

### Search visibility checked across the whole site

- Titles, descriptions, headings, canonical links and Open Graph tags are checked on every page, and a title or description that pages share is one finding listing all of them.
- The sitemap is held against the crawl: pages it lists that no page links to, pages it leaves out, and listed pages marked noindex are reported.
- Pages more than three clicks from the start page, pages that link nowhere, and pages only one other page links to are found in the link graph of the whole site.
- Language versions must name each other back and answer, and each page’s declared language is compared with the language its title and description are written in.
- A staging or development copy left open to indexing is caught before search engines find it.

### Security headers judged, not just detected

- Content-Security-Policy is read directive by directive, from the header or a `<meta>`: inline scripts without a nonce or hash, `eval`, scripts from any host, and a missing `object-src`, `base-uri`, `frame-ancestors` or Trusted Types are each a finding of their own.
- HSTS must last long enough and cover subdomains, and responses must not be sniffed, framed by other sites, or leak full URLs through the referrer.
- Cross-origin isolation, Permissions-Policy and reporting endpoints are checked on every page, not only the front page.
- An X-XSS-Protection header that still turns the retired filter on is reported, since that filter can itself be abused.
- A header that breaks its own grammar, such as an HSTS max-age that is not a number or a Cache-Control directive no cache knows, is one finding naming the fault, instead of passing because it is present or failing every check that reads it.

### Scan server

- The same image runs as an HTTP API with a job queue and a web page where anyone types a domain and reads the report in English, Spanish or Ukrainian, with or without JavaScript.
- Each scan reports its progress while it runs, its report downloads in every format the command line writes, and a site can show its latest grade as a badge linking to the report.
- The instance owner sets policies per domain: ban a top-level domain, limit how often a host may be scanned, cap pages and time, and choose which rules may run. A repeat request inside a set window returns the scan already made, and each client has its own limit.
- Policies reload from a mounted file without a restart.
- A scan cannot be aimed at loopback, private or cloud metadata addresses.

### Crawl once, lint many times

- A crawl can be kept on disk and linted again with changed rules or groups, with no network access.
- An interrupted crawl resumes where it stopped.
- A repeat crawl asks the site only whether each page, script and sitemap changed, and neither downloads nor analyses again what did not.
- Binary downloads are judged by their headers and never fetched in full, so a linked archive or video costs no bandwidth.
- A staging copy is audited as the site it is built for, so its links and sitemap naming the production address are not reported as wrong.

### The footprint of every page view

- The carbon one view of each page emits is estimated from the bytes the page and everything it loads transfer, by the Sustainable Web Design model, and pages over the budget are reported.
- A site’s carbon.txt must be present, valid and current, and the disclosures it names must be reachable.

### TLS configuration scanned in-house

- Every protocol and cipher suite a server accepts is listed, SSLv2, SSLv3, RC4 and export suites included, which today’s TLS libraries can no longer see.
- Broken and weak suites, missing forward secrecy, short Diffie-Hellman primes and record compression are findings, and so are the attacks they open: POODLE, BEAST, SWEET32, FREAK, Logjam, DROWN and CRIME.
- A certificate chain missing its intermediates is caught on TLS 1.3-only servers too.
- A house rule such as “no CBC suites” is a few lines of configuration, not code.
- No outside scanner is asked and nothing is exploited: the server is only asked what it will negotiate, once per origin while the result stays fresh.

### Transport checked per page, not per host

- Certificate, TLS protocol and remote address are read from the connection that served each page, so two backends behind one name are reported instead of hidden.
- Certificates close to expiry, rejected certificates, weak certificate keys or signatures, and outdated TLS versions are findings.
- Timings, redirect chains and cookie flags are recorded for every page, and cookie values never leave the crawler.
- A cookie browsers would silently reject or cut short, and a preload an early hint promises that the page then drops, are reported.

### What the CDN or host adds, kept apart

- Pages a CDN or host serves on the site, such as Cloudflare’s email protection page, are not judged as the site’s own, so they cannot lower its grade.
- Scripts the CDN or host injects are still checked, and their findings are listed under the vendor that serves them.
- A feature switched on in the CDN dashboard that costs visitors something, such as email addresses hidden from anyone without JavaScript, is named with the setting that turns it off.

### The files a site publishes beside its pages

- A missing or expired `security.txt` is reported, so security researchers always have a way to reach you.
- A site with a password field must lead `/.well-known/change-password` somewhere, so password managers can send users straight to the right form.
- Every other known file (privacy signals, OpenID and OAuth metadata, app links, Fediverse node info, AI crawler terms) is checked only when present, so publishing one never goes unnoticed as broken.
- Files for AI agents (`llms.txt`, agent cards, MCP and skill indices) are checked in their own opt-in preset, including links in `llms.txt` that lead to broken pages and whether pages offer a Markdown version.
- A missing page served as HTML counts as absent, so a site that answers every URL does not flood the report.

## Inherited from B19 / Ubuntu

### Persistent APT cache across builds

- Package downloads and index caches persist across builds, so repeated builds skip redundant downloads.
- Cache is keyed by Ubuntu series and architecture, avoiding cross-contamination.
- Optional LAN APT cacher proxy can be enabled for faster local builds.

### Service process management with log routing (b19-exec)

- Long-running processes (daemons, servers) have stdout and stderr automatically routed through the structured logger.
- The service PID is tracked for signal forwarding — Docker stop gracefully terminates the main process.
- Log levels for stdout and stderr streams are independently configurable.
- Exit code of the service is captured and available to downstream hooks.

### Cached artifact downloads with integrity verification

- Downloads are cached locally and in BuildKit persistent storage, so repeated fetches are served from cache.
- SHA-512 hash verification runs at every tier; mismatches fall through to the next source rather than failing.
- Offgrid mode blocks all downloads entirely, failing fast with a clear error on cache miss.
- Supports a near-cache proxy for LAN-only builds that route through a caching proxy.

### Timed command execution with failure reporting (b19-run)

- Any command can be wrapped to get automatic elapsed-time measurement and success/failure reporting.
- Success output is visible only at higher verbosity levels; failure output is always shown.
- In debug mode, command output streams live instead of being buffered.

### Run-once initialization (bootstrap.d)

- One-time setup tasks (database migrations, admin user creation, directory init) run on first container start only.
- Automatic idempotency: completed scripts are never re-run, even across container restarts.
- Failed scripts are retried on next start; successful ones stay locked.
- State can be reset by clearing a volume, triggering a full re-bootstrap.
- Downstream images add their own init scripts by dropping them into a directory.

### Modular build hooks (build.d)

- Build logic lives in composable hook scripts instead of inline Dockerfile commands, making it easy to read, test, and reuse.
- Cross-cutting setup (CA trust, locale, shared installs) is written once and runs on every stage automatically.
- Downstream images inherit parent build logic through the layer overlay — no duplication needed.
- Non-inheritable one-off setup is cleaned up after execution to avoid leaking into later stages.

### Automatic CPU count detection

- CPU count is detected automatically across Docker, Kubernetes, and CI environments without manual configuration.
- Eliminates hardcoded job counts — parallel compilation, template rendering, and tests use the right parallelism everywhere.
- The detected count is available throughout build and runtime for any tool that needs it.

### Declarative dependency management (b19-deps)

- External dependency metadata (URL, version, SHA-512 hash) stored as plain text files, completely separate from build scripts.
- Supports architecture-specific downloads, multi-version series, and nested component paths.
- Dependencies are auto-discovered at Makefile parse time — add files to the right directory and the build picks them up without manual declarations.
- `make fetch` pre-downloads everything for offline builds; version bumps trigger automatic re-fetch and hash updates.

### Pluggable startup system (entrypoint.d)

- Composable hook chain handles signal setup, secrets loading, CPU detection, port validation, template rendering, bootstrap, and service start in order.
- Ad-hoc commands bypass the startup chain automatically and execute directly.
- Individual hooks or the entire entrypoint can be skipped at runtime via environment variables, no image rebuild needed.
- Downstream images override a single hook to launch their service; everything else is inherited.

### Feature toggles for all subsystems

- Every major subsystem (entrypoint, healthchecks, bootstrap, tests, secrets, port validation, i18n, shell hooks) can be disabled at runtime via environment variables.
- Individual entrypoint, bootstrap and health-check hooks can be skipped by name without disabling the whole subsystem.
- No image rebuild required — toggles are runtime-only.

### Built-in health monitoring (healthcheck.d)

- Docker-native healthcheck inherited by every downstream image with no extra configuration.
- Egress checks are opt-in: a container that never reaches the internet carries no check a third party can fail, while one whose job is the internet reports unhealthy the moment the outside is gone.
- Works the same offline as online — egress checks stand down automatically under offgrid mode.
- Adding a check is dropping a script in a directory, not writing Docker plumbing.
- Heavy or rate-limited checks run hourly in the background, so a slow scan never times out the probe or burns a rate limit.

See [use-healthcheck.d](../how-to/use-healthcheck.d.md) for the check list, slot numbering, and configuration.

### Multilingual shell output (b19-i18n)

- All user-facing log messages and script output are translatable via GNU gettext.
- Ships with English, Spanish (`es_CL`), and Ukrainian (`uk_UA`) out of the box.
- Downstream images inherit all parent translations automatically; only new or overridden strings need translating.
- Translations are compiled at build time with no runtime overhead.

### Image lineage tracking

- Every image records its build metadata (namespace, project, version, base image) into a lineage file during build.
- Downstream images chain lineage from their parent, producing a full base-to-current provenance chain.
- The full lineage chain is logged at startup (debug verbosity) and readable from the file at any time, making it easy to trace what a running container was built from.

### Structured, level-filtered logging (b19-log)

- All container output goes through a leveled logger with four thresholds: error, warn, info, debug.
- Messages below the configured verbosity are silently discarded, keeping production logs clean.
- Colors auto-detect terminal support and respect `NO_COLOR=1`.
- Pipable: command output can be routed through the logger to apply level filtering and tags.

### Non-root container by default

- The container runs as a non-root user (`ubuntu`, UID/GID 1000) with all runtime files owned by that user.
- A two-stage build separates root-level system installation from user-level runtime setup.
- User identity is configurable at build time, and an opt-in root start remaps it to the host user so bind mounts keep their ownership.

### Air-gapped / offline build and runtime support

- A single environment variable (`B19_OFFGRID_MODE=Y`) cuts all internet access at build time and runtime.
- Build-time: downloads are blocked, APT updates are skipped, SSH keyscans are skipped. All artifacts must come from cache tiers.
- Runtime: network healthchecks automatically skip with a healthy result, so containers stay green on isolated networks.
- APT package lists can be snapshotted and injected for fully offline image builds.
- LAN services (caching proxies, registries) remain reachable — offgrid blocks internet, not all networking.

### Runtime overlay injection

- Configuration or data files can be injected at container startup by setting `B19_OVERLAY` to a directory name.
- Overlay contents are recursively copied to the container root, overwriting existing files — no image rebuild needed.
- Skipped in immutable mode, preventing runtime modification of production-locked images.

### Reproducible base image (pinned by digest)

- The Ubuntu base image is pinned by SHA-256 digest, not by tag, ensuring deterministic builds.
- Supports multiple Ubuntu series (resolute, noble, jammy) selectable at build time.
- APT mirrors are configurable per architecture for LAN mirrors or air-gapped environments.

### Port validation

- Every environment variable whose name ends in `PORT` is validated at startup against the WHATWG blocklist of forbidden ports and privileged ports (\<1024).
- Catches misconfigurations like `HTTP_PORT=22` early, before the service fails silently.
- Can be disabled at runtime without rebuilding the image.

### Unified lifecycle runner family

- Every lifecycle concern — startup, healthchecks, tests, bootstrap, build, benchmarks, reports, and shell — follows the same discoverable hook pattern.
- Drop a numbered script into a directory and it is auto-discovered and executed, no wiring required.
- Scripts from different image layers merge, so upstream and downstream hooks coexist without conflict.
- Each runner has tailored failure semantics: abort on error, continue and count failures, or always succeed as appropriate.

### Docker secrets auto-loading

- Docker secrets translate to environment variables automatically at container startup, requiring no code changes.
- Dot-notation filenames map to uppercase env vars, keeping naming consistent and predictable.
- Required secrets can be declared by name; the container refuses to start if any are missing.
- Existing environment variables take precedence over secret-derived values, so overrides are straightforward.
- Binary secrets (keys, DER blobs) stay on disk for file-based reads, avoiding Bash truncation issues.

### Interactive shell hooks

- Shell sessions automatically load Docker secrets and any custom hooks added by downstream images.
- Hooks merge via Docker layer overlay, so inherited and project-specific shell setup coexist without conflict.

### Graceful signal handling

- PID 1 is `tini -g`, which reaps zombie processes and forwards signals to the full process group.
- A configurable set of Unix signals (TERM, INT, HUP, USR1, USR2, etc.) is trapped and forwarded to the main service process.
- `docker stop` cleanly terminates the service without orphan processes or signal loss.

### Jinja2 configuration templates (minijinja-cli)

- Jinja2-compatible template rendering at both build time and container startup.
- Drop a `.j2` file anywhere in the app directory; it is discovered at build time and rendered at every startup with all environment variables available.
- Runtime rendering is parallel and automatic — downstream images get it with zero configuration.
- Skip specific templates at runtime with `B19_J2_SKIP_FILES` (comma-separated basenames).
- Immutable mode (`B19_IMMUTABLE=Y`) locks the filesystem to build-time state, skipping all runtime rendering.

### Built-in test framework (test.d)

- Tests run inside the running container via `make test` or `docker exec`.
- Automatically waits for healthchecks to pass before executing.
- No test framework dependency — tests are plain shell scripts with exit codes, and a failed check names what it expected and what it found.
- Supports Jinja2 templates in tests, useful for asserting build-time values at runtime.
- Continues on failure and reports the total count; never hides partial results.

### Nothing hangs forever

- Every startup, test and one-shot step has a time bound, so a wedged tool fails loudly instead of blocking a deploy or a CI run.
- Stalled downloads are aborted, while slow ones of any size still complete.
- A flaky call can be retried with backoff in one flag, without a hand-written loop.
- An opt-in restart turns a service stuck unhealthy into a container the restart policy recovers.

See [use-timeouts](../how-to/use-timeouts.md) for the options, defaults and overrides.

### Pre-installed utility tools

- `mold` as default linker (opt-out available).
- `fd` for file finding, `minijinja-cli` for template rendering.
- `aria2c` for multi-connection downloads, `tini` as PID 1 for zombie reaping.
- Parallel compression tools: `pbzip2`, `pigz`, `pixz`.
- gettext tools for i18n compilation, `cURL` for network operations.

### XDG Base Directory paths

- Standard XDG paths (`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) are set under the app home directory.
- All paths are writable by the non-root user without privilege escalation.
