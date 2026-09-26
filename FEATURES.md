<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

[Español](docs/es/FEATURES.md) · [Українська](docs/uk/FEATURES.md)

# Features

## Project Features

### Client-rendered pages audited as visitors see them

- A page whose tags, links or content appear only after its scripts run is rendered in a real browser, so what gets linted is what search engines and visitors see.
- Only the sections that need a browser are rendered; the rest of the site is crawled over plain HTTP at full speed in the same run, and a section that renders its tags client-side can be detected on its own.
- Console errors, load timings and every resource a page loads at runtime become facts that rules can check.
- Accessibility is checked in the rendered page against WCAG A and AA, so defects that scripts introduce are caught too.
- Keyboard use, motion and speed are tried on a few pages per template: Tab must reach every control and show where focus is, animations must stop when the visitor asks for less motion, text must stay readable in the dark scheme and the higher contrast a page offers, focus and icons must survive Windows high contrast, and Lighthouse scores and lab Core Web Vitals come from the same browser.

### The DNS behind every crawled host

- Missing HTTPS records are reported, so a first visit can start on HTTP/3 without a round trip to discover it.
- CAA is judged against the certificate the site actually serves, so a CA that CAA forbids is caught before it fails a renewal.
- DNSSEC is checked end-to-end: an unsigned zone, weak algorithms, stalled re-signing, and a signed zone that validating resolvers reject.
- Name servers are asked directly, so a lame server or a zone out of sync shows, and a link to a subdomain whose CNAME points nowhere is flagged as a takeover risk.
- Queries go only to the resolver you name, and are reused for as long as the records say.

### One finding per template, not per page

- Pages are grouped by URL pattern, so a defect every post shares is reported once for the post template, with sample pages; costly checks such as accessibility run on only a few pages of each template.
- A group whose pages disagree on a rule gets an advisory that it likely mixes two templates.
- Values that must be unique across the site, such as titles and descriptions, are reported once per duplicate with every URL that shares it.
- Results come as text, JSON or SARIF, so code-scanning views show one row per defect.
- Every run ends with the number of checks passed and a grade from S to F, so sites and releases compare at a glance.

### Image weight measured, not estimated

- Every image the site loads is re-encoded once, and the bytes AVIF, WebP or a tighter encode of its own format would save are reported.
- Each heavy image is one finding with the pages that use it, across the whole site rather than a sample of pages.
- Images that ship far more pixels than they display, or have no width and height to hold their place, are flagged per template.
- Measurements are cached with the image, so a re-run measures only what changed.
- Fonts, style sheets and scripts are weighed the same way: fonts that are not WOFF2, font faces that hide text while they load, and bytes minification would save.

### Dead links, on the site and off it

- A link that leads nowhere, to this site or to another one, is one finding listing every page that carries it.
- Links to other sites are checked once per run and remembered for a week, so a re-run sends them nothing.
- A site that only asks the checker to slow down is not reported as dead.
- Feeds a page advertises in its head are crawled and checked too, even when no link points to them.

### Each origin checked once, beyond its pages

- A missing page is requested on purpose, so a soft 404, or an error page that leaks a stack trace or a server version, is a finding.
- Plain HTTP must lead to HTTPS in one permanent redirect, and the home page must not redirect visitors by their language.
- Plugins add their own once-per-origin or once-per-host checks; their results are reused between runs, and their requests never leave the host they check.

### Feeds, structured data and markup checked on every page

- RSS, Atom and JSON feeds are checked for what feed readers rely on: they parse, name their own URL, and give every item an identifier that never changes, so subscribers never see an old post as new.
- Structured data in JSON-LD, Microdata or RDFa is reported when it does not parse, lacks what its rich result needs, contradicts the page or the rest of the site, uses retired schema.org terms or malformed or contradictory dates, or has breadcrumbs leading to missing or moved pages.
- The web app manifest is checked for what installing the site needs: a name, a start page, a display mode and icons in the sizes phones ask for.
- Vague link text such as “click here” is found in the page’s own language, and a language without a reviewed list is skipped rather than judged in English.
- The analytics and advertising vendors a site loads are listed in one inventory, so what the privacy policy must name is known.

### Page dependencies fetched once

- Scripts, style sheets, images and frames the pages load are fetched once per run, whatever their origin.
- A broken or insecure dependency is one finding listing the pages that use it, not one finding per page.
- Cross-origin scripts without integrity hashes and plain-HTTP resources on HTTPS pages are reported.
- The web app manifest is fetched and judged like any other dependency.

### robots.txt read the way crawlers read it

- A robots.txt that shuts every crawler out of the whole site is reported, since it takes the site out of search results.
- The AI crawlers it names are listed by purpose — training, search or user fetch — with the ones it shuts out and the names no vendor sends any more.
- Content Signals that say something other than yes or no to search, AI input or AI training are reported.

### Rules as data, with presets

- A rule is a fact path plus a JSON Schema, so a new check needs no code.
- Bundled presets cover SEO, security headers, TLS, cookies, redirects, language versions, sitemaps, robots.txt, links and page resources.
- Each URL group runs its own rule sets, and any rule’s severity can be changed or switched off from the command line, the environment or the projectfile.
- Every page’s markup can be validated against the HTML standard and for accessibility defects; a defect a whole template shares is one finding, not one per page.
- Plugins add their own facts, rules, presets, report formats and URL sources beside the bundled ones, and a plain list of URLs can be audited on its own.

### Crawl once, lint many times

- A crawl can be kept on disk and linted again with changed rules or groups, with no network access.
- An interrupted crawl resumes where it stopped.
- A repeat crawl asks the site only whether each page, script and sitemap changed, and neither downloads nor analyses again what did not.
- Binary downloads are judged by their headers and never fetched in full, so a linked archive or video costs no bandwidth.
- A staging copy is audited as the site it is built for, so its links and sitemap naming the production address are not reported as wrong.

### Transport checked per page, not per host

- Certificate, TLS protocol and remote address are read from the connection that served each page, so two backends behind one name are reported instead of hidden.
- Certificates close to expiry, rejected certificates and outdated TLS versions are findings.
- Timings, redirect chains and cookie flags are recorded for every page, and cookie values never leave the crawler.
- A cookie browsers would silently reject or cut short, and a preload an early hint promises that the page then drops, are reported.

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
- User identity is configurable at build time.

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
- No test framework dependency — tests are plain shell scripts with exit codes.
- Supports Jinja2 templates in tests, useful for asserting build-time values at runtime.
- Continues on failure and reports the total count; never hides partial results.

### Pre-installed utility tools

- `mold` as default linker (opt-out available).
- `fd` for file finding, `minijinja-cli` for template rendering.
- `aria2c` for multi-connection downloads, `tini` as PID 1 for zombie reaping.
- Parallel compression tools: `pbzip2`, `pigz`, `pixz`.
- gettext tools for i18n compilation, `cURL` for network operations.

### XDG Base Directory paths

- Standard XDG paths (`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`) are set under the app home directory.
- All paths are writable by the non-root user without privilege escalation.
