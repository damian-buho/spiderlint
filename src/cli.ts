#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import path from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { Command, CommanderError, Option, type Help } from "commander";
import { DESCRIPTION, HOMEPAGE, VERSION } from "./agent.ts";
import { painter, type Paint } from "./color.ts";
import { OfflineMiss, parseDuration, siteDirectory, userCacheDirectory, type CacheMode } from "./cache/index.ts";
import { PURGEABLE, purgeCache } from "./cache/purge.ts";
import { cacheStatus } from "./cache/status.ts";
import { audit, crawl, factsStore, lintStore, loadPlugins, reportStore, warmCache, type Report } from "./index.ts";
import { ConfigError, PROFILES, ROLES, layered, originOf, proxyOf, seedOf, type Config, type FailOn } from "./config/index.ts";
import { BROWSERS, environmentSettings, FETCH_MODES, parseFailOn, parseInteger, pick, SCOPES } from "./config/environment.ts";
import { loadSettings, type Settings } from "./config/policy.ts";
import { parseResolver } from "./crawl/dns.ts";
import { FACT_FORMATS, formatFacts } from "./facts/export.ts";
import { parsePin } from "./crawl/resolve.ts";
import { formatNames, formatter, withSources } from "./plugins/index.ts";
import { NothingStored } from "./store/disk.ts";
import { writeAgentFiles } from "./report/agent.ts";
import { scoreOf } from "./rules/score.ts";
import { explainRule, formatExplanation, formatPresets, formatRules, listPresets, listRules } from "./rules/catalog.ts";
import { handleInterrupts, Interrupted } from "./interrupt.ts";
import { isLogLevel, log, logColor } from "./logger.ts";
import { enableProgress } from "./progress.ts";
import { inSpan, nameSpan, startTelemetry } from "./telemetry.ts";

type Severity = "error" | "warning" | "info" | "hint";

// Flags given on the command line, by long name.
interface Flags {
    [flag: string]: unknown;
    config?: string;
    site?: string[];
    color?: boolean;
    progress?: boolean;
    "log-level"?: string;
    store?: string;
    resume?: boolean;
    "older-than"?: string;
    output?: string;
    "show-hints"?: boolean;
    explain?: boolean;
    stats?: boolean;
    facts?: string[];
    format?: string;
}

interface Verb {
    name: string;
    args: string[];
    group: string;
    summary: string;
    about: string[];
    options: () => Option[];
    examples: [description: string, line: string][];
}

const RANK: Record<Exclude<FailOn, number> | "hint", number> = { never: -1, error: 0, warning: 1, info: 2, hint: 3 };
const DOMAIN = "A domain is example.com or a URL to start from; without a scheme, https:// is assumed.";
const TARGETS = "With no domain, the targets come from org.spiderlint in the config, one run per site.";
const IDS = "Rule IDs and rulesets are comma-separated; an ID may be a glob such as lighthouse/*.";

// --error, --warning, --info and --hint values in argv order, so the last flag naming a rule wins.
const overrideOrder: [Severity, string][] = [];

// A flag whose help ends in its default and environment variable.
function flag(flags: string, text: string, fallback?: string, environment?: string): Option {
    const hints = [fallback && `default: ${fallback}`, environment && `env: ${environment}`].filter(Boolean);
    return new Option(flags, hints.length > 0 ? `${text} (${hints.join(", ")})` : text);
}

// A flag that collects every value it is given.
function repeatable(flags: string, text: string, fallback?: string, environment?: string): Option {
    return flag(flags, text, fallback, environment).argParser((value: string, previous?: string[]) => [...(previous ?? []), value]);
}

// A severity override flag, recorded in argv order.
function severity(name: Severity, text: string): Option {
    return flag(`--${name} <ids>`, text, undefined, `SPIDERLINT_OVERRIDE_${name.toUpperCase()}`).argParser((value: string, previous?: string[]) => {
        overrideOrder.push([name, value]);
        return [...(previous ?? []), value];
    });
}

// A --name and --no-name pair, shown as one --[no-]name row.
function toggle(name: string, text: string, fallback: string, environment?: string): Option[] {
    return [Object.assign(flag(`--${name}`, text, fallback, environment), { flags: `--[no-]${name}` }), new Option(`--no-${name}`).hideHelp()];
}

// Options under one help heading.
function section(title: string, options: Option[]): Option[] {
    return options.map((option) => option.helpGroup(`${title}:`));
}

function crawlOptions(): Option[] {
    return section("Crawl", [
        flag("--fetch <mode>", "auto, http, browser or adaptive", "auto", "SPIDERLINT_FETCH"),
        flag("--browser <name>", "chromium, firefox or webkit", "chromium", "SPIDERLINT_BROWSER"),
        flag("--scope <scope>", "follow links within the origin, host or domain", "origin", "SPIDERLINT_SCOPE"),
        flag("--concurrency <n>", "pages in flight, 0 for one per CPU, halved in a browser", "0", "SPIDERLINT_CONCURRENCY"),
        flag("--rate <n>", "requests per minute, 0 for no limit", "0", "SPIDERLINT_RATE"),
        flag("--timeout <seconds>", "seconds one page may take", "60", "SPIDERLINT_TIMEOUT"),
        flag("--profile <name>", "tor or i2p: its local proxy, concurrency 4, timeout 240", undefined, "SPIDERLINT_PROFILE"),
        flag("--proxy <url>", "http, https or socks5h proxy for every request", undefined, "SPIDERLINT_PROXY"),
        flag("--max-pages <n>", "page limit, 0 for none", "0", "SPIDERLINT_MAX_PAGES"),
        flag("--max-depth <n>", "link depth limit, 0 for none", "0", "SPIDERLINT_MAX_DEPTH"),
        flag("--max-body-size <bytes>", "body size cap", "10000000", "SPIDERLINT_MAX_BODY_SIZE"),
        repeatable("--include-urls <glob>", "crawl only URLs whose path and query match, repeatable", undefined, "SPIDERLINT_INCLUDE_URLS"),
        repeatable("--exclude-urls <glob>", "skip URLs whose path and query match, repeatable", undefined, "SPIDERLINT_EXCLUDE_URLS"),
        repeatable("--source <id:arg>", "add a plugin source’s URLs; list:FILE crawls a URL list only, repeatable", undefined, "SPIDERLINT_SOURCES"),
        flag("--no-robots", "ignore robots.txt", undefined, "SPIDERLINT_ROBOTS=false"),
        flag("--no-sitemap", "skip sitemap discovery", undefined, "SPIDERLINT_SITEMAP=false"),
        flag("--no-keepalive", "one connection per request", undefined, "SPIDERLINT_KEEPALIVE=false"),
        flag("--no-resources", "skip scripts, styles, images and fonts", undefined, "SPIDERLINT_RESOURCES=false"),
        flag("--canonical-origin <url>", "origin the pages are built for; its URLs count as the crawled one’s", undefined, "SPIDERLINT_CANONICAL_ORIGIN"),
        flag("--role <role>", "production, staging or development", "production", "SPIDERLINT_ROLE"),
        flag("--resolver <list>", "DNS servers to ask, address[:port],…", "system", "SPIDERLINT_RESOLVER"),
        repeatable("--resolve <pin>", "connect to host[:port]:address instead of resolving host, repeatable", undefined, "SPIDERLINT_RESOLVE"),
        flag("--no-allow-private", "refuse loopback, private and link-local addresses", undefined, "SPIDERLINT_ALLOW_PRIVATE=false"),
        flag("--no-browser-install", "never download a missing browser, fail naming the install command", undefined, "SPIDERLINT_BROWSER_INSTALL=false"),
    ]);
}

function ruleOptions(): Option[] {
    return section("Rules", [
        repeatable("--rules <rulesets>", "rulesets or rule IDs to run in every group", "recommended", "SPIDERLINT_RULES"),
        flag("--exclude-rules <ids>", "skip these rules", undefined, "SPIDERLINT_EXCLUDE_RULES"),
        severity("error", "report these rules as errors"),
        severity("warning", "report these rules as warnings"),
        severity("info", "report these rules as info"),
        severity("hint", "report these rules as hints, which neither grade nor fail"),
    ]);
}

function reportOptions(): Option[] {
    return section("Report", [
        flag("--format <format>", `${formatNames().join(", ")} or a plugin’s`, "human", "SPIDERLINT_FORMAT"),
        flag("--fail-on <level>", "exit 1 at error, warning, info, a score from 0.1 to 9.9, or never", "error", "SPIDERLINT_FAIL_ON"),
        flag("--unfold", "one finding per page, every URL and location listed", undefined, "SPIDERLINT_FOLD=false"),
        flag("--show-hints", "list hints in human output, not only their count"),
        flag("--explain", "print each finding’s fix and docs in human output"),
        flag("--stats", "count, min, median, p95, max and total of each numeric fact"),
        flag("--output <dir>", "with --format agent, one Markdown prompt per rule in dir"),
    ]);
}

// The store directory, its default shown as the path it resolves to.
function storeOption(): Option {
    return flag("--store <dir>", "store directory", path.join(userCacheDirectory(), "<host>"));
}

function storeOptions(): Option[] {
    return section("Store", [storeOption()]);
}

function cacheOptions(): Option[] {
    return section("Store", [
        storeOption(),
        flag("--resume", "continue an interrupted crawl"),
        flag("--no-cache", "neither read nor write the cache", undefined, "SPIDERLINT_CACHE=off"),
        flag("--refresh", "refetch everything, rewrite the cache", undefined, "SPIDERLINT_CACHE=refresh"),
        flag("--offline", "cache only, a miss exits 3", undefined, "SPIDERLINT_CACHE=offline"),
    ]);
}

function factOptions(): Option[] {
    return section("Output", [flag("--format <format>", FACT_FORMATS.join(", "), "human"), repeatable("--facts <glob>", "fact paths to show, repeatable")]);
}

function listingOptions(): Option[] {
    return section("Output", [flag("--format <format>", "human or json", "human", "SPIDERLINT_FORMAT")]);
}

const VERBS: Verb[] = [
    {
        name: "audit",
        args: ["[domain...]"],
        group: "Check a site",
        summary: "crawl a site, then lint it",
        about: ["Keeps the pages in the store, so lint and show-report reuse them offline.", DOMAIN, TARGETS, IDS],
        options: () => [...crawlOptions(), ...ruleOptions(), ...reportOptions(), ...cacheOptions()],
        examples: [
            ["Audit a site with the recommended rules", "spiderlint audit example.com"],
            ["Write a SARIF report for code scanning", "spiderlint audit example.com --format sarif > report.sarif"],
            ["Run every rule except Lighthouse’s", "spiderlint audit example.com --rules all --exclude-rules 'lighthouse/*'"],
            ["Check a single rule", "spiderlint audit example.com --rules http/alt-svc-h3"],
            ["Audit only the URLs listed in a file", "spiderlint audit --source list:urls.txt"],
        ],
    },
    {
        name: "crawl",
        args: ["[domain...]"],
        group: "Check a site",
        summary: "fetch pages into the store, lint nothing",
        about: [DOMAIN, TARGETS],
        options: () => [...crawlOptions(), ...cacheOptions()],
        examples: [
            ["Crawl now, lint later", "spiderlint crawl example.com"],
            ["Continue a crawl that was interrupted", "spiderlint crawl example.com --resume"],
        ],
    },
    {
        name: "lint",
        args: ["[domain...]"],
        group: "Check a site",
        summary: "lint the stored pages, with no network",
        about: [DOMAIN, TARGETS, IDS],
        options: () => [...ruleOptions(), ...reportOptions(), ...storeOptions()],
        examples: [
            ["Lint the last crawl, failing on warnings too", "spiderlint lint example.com --fail-on warning"],
            ["Try every rule on the same pages", "spiderlint lint example.com --rules all"],
        ],
    },
    {
        name: "show-report",
        args: ["[domain...]"],
        group: "Check a site",
        summary: "print the stored report again, in any format",
        about: [DOMAIN, TARGETS],
        options: () => [...reportOptions(), ...storeOptions()],
        examples: [["Turn the last report into a web page", "spiderlint show-report example.com --format html > report.html"]],
    },
    {
        name: "show-facts",
        args: ["<url>"],
        group: "Inspect",
        summary: "fetch one page and print its facts",
        about: ["Facts are what spiderlint records about a page, such as headers, HTML, TLS, timings and sizes; rules judge them. The site’s own facts are under site.", DOMAIN],
        options: () => [...crawlOptions(), ...factOptions()],
        examples: [
            ["See every fact about the home page", "spiderlint show-facts example.com"],
            ["Print one page’s facts as JSON", "spiderlint show-facts example.com/about/ --format json"],
        ],
    },
    {
        name: "export-facts",
        args: ["[domain...]"],
        group: "Inspect",
        summary: "print every stored page’s facts, no network",
        about: ["Facts are what spiderlint records about a page, such as headers, HTML, TLS, timings and sizes; rules judge them.", DOMAIN, TARGETS],
        options: () => [...factOptions(), ...storeOptions()],
        examples: [["Export page weight and timings as CSV", "spiderlint export-facts example.com --format csv --facts 'co2.*' --facts 'http.timing.*'"]],
    },
    {
        name: "list-groups",
        args: ["[domain...]"],
        group: "Inspect",
        summary: "count the pages in each URL group",
        about: ["Crawls the site and names the pages no group in org.spiderlint.groups matched.", DOMAIN, TARGETS],
        options: crawlOptions,
        examples: [["Check the groups match the site’s templates", "spiderlint list-groups example.com --max-pages 200"]],
    },
    {
        name: "list-rules",
        args: ["[ruleset|id...]"],
        group: "Rules",
        summary: "list rules at the severity this config gives",
        about: [IDS],
        options: () => [...ruleOptions(), ...listingOptions()],
        examples: [
            ["List the security header rules", "spiderlint list-rules security-headers"],
            ["List every rule as JSON", "spiderlint list-rules --format json"],
        ],
    },
    {
        name: "list-presets",
        args: [],
        group: "Rules",
        summary: "list shipped rulesets and the groups using them",
        about: [],
        options: listingOptions,
        examples: [["See which presets exist", "spiderlint list-presets"]],
    },
    {
        name: "explain-rule",
        args: ["<rule>"],
        group: "Rules",
        summary: "show what a rule reads and expects, and its fix",
        about: [],
        options: listingOptions,
        examples: [["Explain a rule before turning it on", "spiderlint explain-rule html/theme-color-schemes"]],
    },
    {
        name: "show-cache",
        args: ["[domain...]"],
        group: "Cache",
        summary: "show the entries, bytes and age of each bucket",
        about: [DOMAIN],
        options: storeOptions,
        examples: [["See what is cached for a site", "spiderlint show-cache example.com"]],
    },
    {
        name: "purge-cache",
        args: ["[bucket]", "[domain...]"],
        group: "Cache",
        summary: "delete a site’s cached entries",
        about: [`A bucket is one of ${[...PURGEABLE].join(", ")}; with none, every bucket is purged.`, DOMAIN],
        options: () => [...section("Purge", [flag("--older-than <age>", "only entries older than 45s, 30m, 24h or 7d")]), ...storeOptions()],
        examples: [["Drop cached pages older than a week", "spiderlint purge-cache pages example.com --older-than 7d"]],
    },
    {
        name: "warm-cache",
        args: ["[domain...]"],
        group: "Cache",
        summary: "fetch robots.txt and sitemaps without crawling",
        about: [DOMAIN, TARGETS],
        options: () => [...crawlOptions(), ...storeOptions()],
        examples: [["Prefetch robots.txt and sitemaps before an --offline run", "spiderlint warm-cache example.com"]],
    },
];

// Usage, description, command groups, then option groups; a command’s own screen leaves -h to the main one.
function layout(command: Command, helper: Help): string {
    const width = helper.padWidth(command, helper);
    const item = (term: string, text: string) => helper.formatItem(term, width, text, helper);
    const list = (heading: string, items: string[]) => (items.length > 0 ? ["", helper.styleTitle(heading), ...items] : []);
    const commands = helper.groupItems([...command.commands], helper.visibleCommands(command), (sub) => sub.helpGroup() || "Commands:");
    const options = helper.groupItems(
        [...command.options],
        helper.visibleOptions(command).filter((option) => !command.parent || option.long !== "--help"),
        (option) => option.helpGroupHeading ?? "Options:",
    );
    return [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(command))}`,
        helper.boxWrap(helper.styleCommandDescription(helper.commandDescription(command)), helper.helpWidth ?? 80),
        ...[...commands].flatMap(([heading, subs]) =>
            list(
                heading,
                subs.map((sub) => item(helper.styleSubcommandTerm(helper.subcommandTerm(sub)), helper.styleSubcommandDescription(helper.subcommandDescription(sub)))),
            ),
        ),
        ...[...options].flatMap(([heading, flags]) =>
            list(
                heading,
                flags.map((option) => item(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)))),
            ),
        ),
        "",
    ].join("\n");
}

// Commander’s error on one line; an old command name points at the verbs that replaced it.
function oneLine(root: Command, message: string): string {
    const name = /unknown command '([^']+)'/.exec(message)?.[1];
    const verbs = root.commands.map((command) => command.name()).filter((verb) => name !== undefined && verb.split("-").includes(name));
    log.debug({ name, verbs }, "command line refused");
    return verbs.length > 0
        ? `unknown command '${name}' (did you mean ${verbs.join(" or ")}?)`
        : message
              .replace(/^error: /, "")
              .replaceAll("(Did you", "(did you")
              .split("\n")
              .filter(Boolean)
              .join(" ");
}

// The whole command line: tool-wide options, one command per verb, each calling `act`.
function program(act: (command: Command) => Promise<void>): Command {
    const root = new Command("spiderlint");
    const paint = (): Paint => painter(process.stdout, root.getOptionValue("color") as boolean | undefined);
    const hasColors = () => root.getOptionValue("color") !== false;
    root.configureHelp({
        formatHelp: layout,
        styleTitle: (text) => paint()("bold", text),
        styleUsage: (text) => text.replaceAll("...", "…"),
        styleSubcommandTerm: (text) => paint()("cyan", text.replace(" [options]", "").replaceAll("...", "…")),
        styleOptionTerm: (text) => paint()("cyan", text),
        styleOptionDescription: (text) => text.replace(/ (\((default|env): [^)]*\))$/, (_hint, hint: string) => ` ${paint()("dim", hint)}`),
    });
    root.configureOutput({ writeOut: (text) => console.log(text.replace(/\n$/, "")), writeErr: (text) => console.error(text.replace(/\n$/, "")), getOutHasColors: hasColors, getErrHasColors: hasColors, outputError: (message, write) => write(`spiderlint: ${oneLine(root, message)} (see spiderlint --help)\n`) });
    root.exitOverride();
    root.usage("<command> [domain…] [options]").description(DOMAIN);
    root.addOption(flag("--config <path>", "settings file", "projectfile.yaml", "SPIDERLINT_CONFIG"));
    root.addOption(repeatable("--site <names>", "only these org.spiderlint.sites, repeatable", "all"));
    for (const option of [...toggle("color", "force or disable color", "auto", "NO_COLOR, FORCE_COLOR"), ...toggle("progress", "status line on an interactive stderr", "auto")]) root.addOption(option);
    root.addOption(flag("--log-level <level>", "trace, debug, info, warn, error or silent", "warn", "SPIDERLINT_LOG_LEVEL"));
    root.version(VERSION, "-V, --version", "show the version");
    root.helpOption("-h, --help", "show this screen, or a command’s with the command");
    root.helpCommand("help [command]", "show a command’s options and examples");
    root.addHelpText("before", () => [paint()("bold", "spiderlint"), DESCRIPTION, paint()("underline", HOMEPAGE), ""].join("\n"));
    root.addHelpText("after", () =>
        ["", `Run ${paint()("green", "spiderlint <command> --help")} for a command’s options and examples.`, "", paint()("bold", "Exit codes:"), "  0  clean", "  1  findings at or above --fail-on", "  2  usage or config error", "  3  nothing fetched, or an --offline cache miss", "  4  the run failed"].join("\n"),
    );
    const shared = root.options.filter((option) => !option.hidden && option.long !== "--version").map((option) => option.flags.split(" ", 1)[0]);
    for (const verb of VERBS) {
        const command = root.command(verb.name).helpGroup(`${verb.group}:`).summary(verb.summary);
        command.description([`${verb.summary[0]?.toUpperCase()}${verb.summary.slice(1)}.`, ...(verb.about.length > 0 ? ["", ...verb.about] : [])].join("\n"));
        for (const argument of verb.args) command.argument(argument);
        for (const option of verb.options()) command.addOption(option);
        command.addHelpText("after", () => ["", `Options for every command, see ${paint()("green", "spiderlint --help")}:`, `  ${shared.join(", ")}`, "", paint()("bold", "Examples:"), ...verb.examples.flatMap(([description, line]) => [`  ${description}:`, `    ${paint()("green", line)}`])].join("\n"));
        command.action(async (...arguments_: unknown[]) => act(arguments_.at(-1) as Command));
    }
    return root;
}

// Flags given on the command line, keyed by long name; defaults and unset flags are left out.
function flagsOf(command: Command): Flags {
    const given = Object.entries(command.optsWithGlobals()).filter(([key]) => command.getOptionValueSourceWithGlobals(key) === "cli");
    return Object.fromEntries(given.map(([key, value]) => [key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), value]));
}

// At most one of --no-cache, --refresh, --offline; undefined when none is passed.
function cacheMode(values: Record<string, unknown>): CacheMode | undefined {
    const modes = [values.cache === false && "off", values.refresh === true && "refresh", values.offline === true && "offline"].filter((mode): mode is CacheMode => mode !== false);
    if (modes.length > 1) throw new ConfigError(`--no-cache, --refresh and --offline exclude each other (got ${modes.join(", ")})`);
    return modes[0];
}

// 1 once any finding reaches --fail-on, which no hint does; 3 when nothing was fetched.
function exitCode(report: Report, failOn: FailOn): number {
    if (report.pages.length === 0) return 3;
    if (typeof failOn === "number") return report.findings.some((finding) => finding.severity !== "hint" && scoreOf(finding) >= failOn) ? 1 : 0;
    return report.findings.some((finding) => finding.severity !== "hint" && RANK[finding.severity] <= RANK[failOn]) ? 1 : 0;
}

function groupsOf(report: Report): string {
    const counts: Record<string, number> = {};
    for (const page of report.pages) counts[page.group] = (counts[page.group] ?? 0) + 1;
    const modes = new Map(Object.entries(report.summary.fetch ?? {}));
    const lines = Object.entries(counts).map(([group, pages]) => `${group}: ${pages} pages${modes.has(group) ? `, fetch ${modes.get(group)}` : ""}`);
    const fell = report.pages.filter((page) => page.group === "default").map((page) => `  ${page.url.href}`);
    return [...lines, ...(fell.length > 0 ? ["fell through to default:", ...fell] : [])].join("\n");
}

function splitIds(raw: string): string[] {
    return raw.split(/[\s,]+/).filter((entry) => entry.length > 0);
}

// `--error`/`--warning`/`--info`/`--hint` in argv order, so the last flag naming a rule wins.
function overridesInOrder(): Record<string, Severity> {
    return Object.fromEntries(overrideOrder.flatMap(([name, raw]) => splitIds(raw).map((id) => [id, name])));
}

// Flags actually passed become a Settings patch; an unset flag leaves the ladder's lower tiers alone.
function flagSettings(values: Record<string, unknown>): Settings {
    const overrides = overridesInOrder();
    return {
        ...(values["canonical-origin"] !== undefined && { canonicalOrigin: originOf("--canonical-origin", values["canonical-origin"] as string) }),
        ...(values.role !== undefined && { role: pick("--role", values.role as string, ROLES) }),
        ...(values.resolver !== undefined && { resolver: parseResolver(values.resolver as string) }),
        ...(values.resolve !== undefined && { resolve: (values.resolve as string[]).map((pin) => parsePin(pin)) }),
        ...(values.fetch !== undefined && { fetch: pick("--fetch", values.fetch as string, FETCH_MODES) }),
        ...(values.browser !== undefined && { browser: pick("--browser", values.browser as string, BROWSERS) }),
        ...(values.scope !== undefined && { scope: pick("--scope", values.scope as string, SCOPES) }),
        ...(values.concurrency !== undefined && { concurrency: parseInteger("--concurrency", values.concurrency as string) }),
        ...(values.rate !== undefined && { rate: parseInteger("--rate", values.rate as string) }),
        ...(values.timeout !== undefined && { timeout: parseInteger("--timeout", values.timeout as string) }),
        ...(values.profile !== undefined && { profile: pick("--profile", values.profile as string, Object.keys(PROFILES)) }),
        ...(values.proxy !== undefined && { proxy: proxyOf("--proxy", values.proxy as string) }),
        ...(values["max-pages"] !== undefined && { maxPages: parseInteger("--max-pages", values["max-pages"] as string) }),
        ...(values["max-depth"] !== undefined && { maxDepth: parseInteger("--max-depth", values["max-depth"] as string) }),
        ...(values["max-body-size"] !== undefined && { maxBodySize: parseInteger("--max-body-size", values["max-body-size"] as string) }),
        ...(values["include-urls"] !== undefined && { includeUrls: values["include-urls"] as string[] }),
        ...(values.source !== undefined && { sources: values.source as string[] }),
        ...(values["exclude-urls"] !== undefined && { excludeUrls: values["exclude-urls"] as string[] }),
        ...(values.robots !== undefined && { robots: values.robots as boolean }),
        ...(values.sitemap !== undefined && { sitemap: values.sitemap as boolean }),
        ...(values.keepalive !== undefined && { keepalive: values.keepalive as boolean }),
        ...(values.resources !== undefined && { fetchResources: values.resources as boolean }),
        ...(values["allow-private"] !== undefined && { allowPrivate: values["allow-private"] as boolean }),
        ...(values["browser-install"] !== undefined && { browserInstall: values["browser-install"] as boolean }),
        ...(values.unfold !== undefined && { fold: !(values.unfold as boolean) && { threshold: 0.8, min: 3 } }),
        ...(values["fail-on"] !== undefined && { failOn: parseFailOn("--fail-on", values["fail-on"] as string) }),
        ...(values.format !== undefined && { format: values.format as string }),
        ...(values["exclude-rules"] !== undefined && { excludeRules: splitIds(values["exclude-rules"] as string) }),
        ...(values.rules !== undefined && { rules: (values.rules as string[]).flatMap((raw) => splitIds(raw)) }),
        ...(Object.keys(overrides).length > 0 && { overrides }),
        cacheMode: cacheMode(values),
    };
}

// One line naming the bad flag, pointing at --help; exit code 2.
function usageError(message: string): number {
    console.error(`spiderlint: ${message} (see spiderlint --help)`);
    return 2;
}

// Exit codes: 0 clean, 1 findings, 2 usage or config, 3 no seed fetched or an --offline miss, 4 the run failed.
async function main(argv: string[]): Promise<number> {
    let code = 0;
    const root = program(async (command) => {
        code = await execute(command);
    });
    try {
        await root.parseAsync(argv, { from: "user" });
    } catch (error) {
        if (!(error instanceof CommanderError)) throw error;
        log.debug({ code: error.code, exitCode: error.exitCode }, "command line answered by commander");
        return error.exitCode === 0 ? 0 : 2;
    }
    return code;
}

// One verb over every chosen site, with the exit code main documents.
async function execute(verb: Command): Promise<number> {
    const values = flagsOf(verb);
    if (values["log-level"] !== undefined && !isLogLevel(values["log-level"])) return usageError(`--log-level: unknown level ${values["log-level"]}`);
    if (values["log-level"] !== undefined) log.level = values["log-level"];
    logColor(values.color);
    const isProgress = values.progress ?? (process.stderr.isTTY && process.stderr.columns > 0 && process.env.SPIDERLINT_LOG_FORMAT !== "json" && log.level !== "silent");
    enableProgress(isProgress);
    log.debug({ isProgress, flag: values.progress, isTTY: process.stderr.isTTY, columns: process.stderr.columns }, "status line chosen");
    const command = verb.name();
    const seeds = verb.args;
    nameSpan(`spiderlint ${command}`);
    try {
        const { settings: fileSettings, sites } = loadSettings(values.config ?? process.env.SPIDERLINT_CONFIG);
        // Shared settings, then the site’s patch, then environment and flags.
        const configFor = (site: Settings): Config => layered([fileSettings, site, environmentSettings(process.env), flagSettings(values)]);
        const config = configFor({});
        if (command === "explain-rule") {
            await loadPlugins(config.plugins, config.pluginSettings);
            const explained = explainRule(config, seeds[0] as string);
            console.log(config.format === "json" ? JSON.stringify(explained, undefined, 2) : formatExplanation(explained, painter(process.stdout, values.color)));
            return 0;
        }
        if (command === "list-rules" || command === "list-presets") {
            await loadPlugins(config.plugins, config.pluginSettings);
            const paint = painter(process.stdout, values.color);
            const listed = command === "list-rules" ? listRules(config, seeds) : listPresets(config);
            if (config.format === "json") console.log(JSON.stringify(listed, undefined, 2));
            else console.log(command === "list-rules" ? formatRules(listed as ReturnType<typeof listRules>, paint) : formatPresets(listed as ReturnType<typeof listPresets>, paint));
            return 0;
        }
        // `purge-cache` may name a bucket before its domains.
        const bucket = command === "purge-cache" && PURGEABLE.has(seeds[0] ?? "") ? seeds[0] : undefined;
        const targets = seeds.slice(bucket ? 1 : 0);
        const named = (values.site ?? []).flatMap((raw) => splitIds(raw));
        const unknown = named.filter((name) => !Object.hasOwn(sites, name));
        if (unknown.length > 0) throw new ConfigError(`--site: unknown site ${unknown.join(", ")} (declared: ${Object.keys(sites).join(", ") || "none"})`);
        // Command-line domains win over every declared site; with none declared the shared settings are the one site.
        const chosen = targets.length > 0 || Object.keys(sites).length === 0 ? [["", {}] as const] : Object.entries(sites).filter(([name]) => named.length === 0 || named.includes(name));
        const isFacts = command === "show-facts" || command === "export-facts";
        if (chosen.length > 1 && (isFacts || config.format !== "human")) throw new ConfigError(`${isFacts ? command : `--format ${config.format}`}: one document per run, pick a site with --site (declared: ${Object.keys(sites).join(", ")})`);
        let worst = 0;
        for (const [name, site] of chosen) {
            if (name) log.debug({ site: name }, "site selected");
            if (name && chosen.length > 1) console.log(`\n${name}`);
            worst = Math.max(worst, await run(verb, targets, bucket, configFor(site), values));
        }
        return worst;
    } catch (error) {
        if (error instanceof Interrupted) {
            log.warn({ command, code: error.code }, error.message);
            return error.code;
        }
        const isConfig = error instanceof ConfigError;
        const isOfflineMiss = error instanceof OfflineMiss || error instanceof NothingStored;
        log.error({ command, error: error instanceof Error ? error.message : String(error), isConfig, isOfflineMiss }, `${command} aborted`);
        return isConfig ? 2 : isOfflineMiss ? 3 : 4;
    }
}

// One command over one site’s config; the exit code as main documents it.
async function run(verb: Command, targets: string[], bucket: string | undefined, config: Config, values: Flags): Promise<number> {
    const command = verb.name();
    const isStored = ["crawl", "lint", "show-report"].includes(command);
    {
        await loadPlugins(config.plugins, config.pluginSettings);
        if (targets.length > 0) config.seeds = targets;
        config.seeds = config.seeds.map((seed) => seedOf(seed));
        config = await withSources(config);
        const invalid = config.seeds.find((seed) => !URL.canParse(seed) || !["http:", "https:"].includes(new URL(seed).protocol));
        if (invalid !== undefined) throw new ConfigError(`${invalid}: not an http or https URL`);
        // An explicit --store, else the seeds’ directory in the user cache; `--no-cache` keeps an audit in memory.
        const store = values.store ?? (command === "audit" && config.cacheMode === "off" ? undefined : siteDirectory(config.seeds));
        log.debug({ command, store, seeds: config.seeds.length, cache: config.cacheMode }, "store chosen");
        if (command === "show-facts" || command === "export-facts") return await facts(command, config, store, values);
        const formatName = pick("--format", config.format, formatNames());
        const format = formatter(formatName);
        const failOn = typeof config.failOn === "number" ? config.failOn : RANK[config.failOn];
        const requiresSeeds = ["audit", "crawl", "list-groups", "warm-cache"].includes(command);
        if (!format || failOn === undefined || (requiresSeeds && config.seeds.length === 0) || (isStored && !store)) {
            verb.outputHelp({ error: true });
            return 2;
        }
        if (formatName !== "agent" && values.output !== undefined) throw new ConfigError(`--output: writes one file per rule for --format agent only, not ${formatName}`);
        if (command === "purge-cache") {
            const olderThan = parseDuration(values["older-than"] ?? "0");
            if (olderThan === undefined) throw new ConfigError(`--older-than: invalid duration ${values["older-than"]} (expected seconds or 45s, 30m, 24h, 7d)`);
            const purged = await purgeCache(store, bucket, olderThan);
            for (const [name, count] of Object.entries(purged)) console.log(`${name.padEnd(9)} ${String(count).padStart(7)} entries purged`);
            return 0;
        }
        if (command === "show-cache") {
            const buckets = await cacheStatus(store);
            for (const entry of buckets) console.log(`${entry.bucket.padEnd(9)} ${String(entry.entries).padStart(7)} entries ${String(entry.bytes).padStart(11)} bytes  ${entry.oldest} … ${entry.newest}`);
            return 0;
        }
        if (command === "warm-cache") {
            const warmed = await warmCache(config, store as string);
            console.log(`${warmed.origins} origins, ${warmed.sitemaps} sitemap files, ${warmed.urls} listed URLs cached`);
            return 0;
        }
        if (command === "crawl") {
            const pages = await crawl(config, store as string, values.resume === true);
            console.log(`${pages.length} pages stored in ${store}`);
            return pages.length === 0 ? 3 : 0;
        }
        // A report to stdout in the chosen format, or one agent prompt per rule under --output.
        const emit = async (report: Report) =>
            values.output === undefined ? console.log(format(report, painter(process.stdout, values.color), config.fold === false, undefined, values["show-hints"] === true, values.explain === true, values.stats === true)) : writeAgentFiles(values.output, report, values["show-hints"] === true);
        if (command === "lint" || command === "show-report") {
            const stored = command === "lint" ? await lintStore(config, store as string) : await reportStore(store as string);
            await emit(stored);
            return exitCode(stored, config.failOn);
        }
        const options = command === "audit" ? { store, resume: values.resume === true } : {};
        const report = await audit(config, options);
        if (command === "list-groups") console.log(groupsOf(report));
        else await emit(report);
        return command === "audit" ? exitCode(report, config.failOn) : report.pages.length === 0 ? 3 : 0;
    }
}

// Every stored page with export-facts, else the first seed crawled alone, in human, json, yaml or csv; 3 when there is no page.
async function facts(command: string, config: Config, store: string | undefined, values: Flags): Promise<number> {
    const format = pick("--format", values.format ?? "human", FACT_FORMATS);
    const isAll = command === "export-facts";
    log.debug({ format, isAll, store, picks: values.facts }, "facts export chosen");
    if (config.seeds.length === 0) throw new ConfigError(`${command}: no domain, and org.spiderlint names no targets`);
    const { pages, site } = isAll ? await factsStore(config, store as string) : await audit({ ...config, maxPages: 1, groups: { default: { rules: [] } } });
    console.log(formatFacts(pages, site, format, values.facts ?? [], !isAll, painter(process.stdout, values.color)));
    return pages.length === 0 ? 3 : 0;
}

// Trust the OS store beside Node’s bundled roots, as `node --use-system-ca` does.
const systemRoots = getCACertificates("system");
setDefaultCACertificates([...getCACertificates("default"), ...systemRoots]);
log.debug({ system: systemRoots.length }, "system CA certificates trusted");
const telemetry = await startTelemetry("spiderlint");
handleInterrupts();
process.exitCode = await inSpan("spiderlint", {}, async (span) => {
    const code = await main(process.argv.slice(2));
    span.setAttribute("process.exit.code", code);
    return code;
});
await telemetry?.shutdown();
