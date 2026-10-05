// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, defaults, layered, overlay, seedOf } from "../src/config/index.ts";
import { environmentSettings } from "../src/config/environment.ts";
import { loadSettings } from "../src/config/policy.ts";
import { validateSubtree } from "../src/config/schema.ts";

const ORIGINAL_CWD = process.cwd();

function temporaryDirectory(): string {
    return mkdtempSync(path.join(tmpdir(), "spiderlint-config-test-"));
}

// Puts a script named `pf-cli` first on PATH so `spawnSync("pf-cli", …)` finds it instead of the real one.
function withFakePfCli<T>(script: string, run: () => T): T {
    const directory = temporaryDirectory();
    const binaryPath = path.join(directory, "pf-cli");
    writeFileSync(binaryPath, `#!/bin/sh\n${script}\n`);
    chmodSync(binaryPath, 0o755);
    const original = process.env.PATH;
    process.env.PATH = `${directory}:${original}`;
    try {
        return run();
    } finally {
        process.env.PATH = original;
        rmSync(directory, { recursive: true, force: true });
    }
}

// Removes pf-cli from PATH entirely for the duration of `run`.
function withoutPfCli<T>(run: () => T): T {
    const original = process.env.PATH;
    process.env.PATH = "";
    try {
        return run();
    } finally {
        process.env.PATH = original;
    }
}

describe("overlay", () => {
    it("applies only the defined keys of a patch, in ladder order", () => {
        const base = defaults();
        const withFile = overlay(base, { fetch: "browser", maxPages: 10 });
        const withEnvironment = overlay(withFile, { maxPages: 20 });
        const withFlags = overlay(withEnvironment, { scope: undefined, fetch: "http" });
        assert.equal(withFlags.fetch, "http");
        assert.equal(withFlags.maxPages, 20);
        assert.equal(withFlags.scope, "origin");
    });
});

describe("seedOf", () => {
    it("prepends https:// to a domain, a host with a port and a path, and keeps a URL", () => {
        assert.deepEqual(
            ["example.com", "localhost:8080", "example.com/about/", "ftp://example.com/"].map((seed) => seedOf(seed)),
            ["https://example.com", "https://localhost:8080", "https://example.com/about/", "ftp://example.com/"],
        );
    });
});

describe("layered", () => {
    it("lays a profile over the defaults and under every patch", () => {
        const tor = layered([{ profile: "tor" }]);
        assert.deepEqual([tor.concurrency, tor.timeout], [4, 240]);
        const raised = layered([{ concurrency: 8 }, environmentSettings({ SPIDERLINT_PROFILE: "tor" })]);
        assert.deepEqual([raised.concurrency, raised.timeout], [8, 240]);
        assert.equal(layered([]).timeout, 60);
        assert.throws(() => environmentSettings({ SPIDERLINT_PROFILE: "no-such-profile" }), ConfigError);
        assert.throws(() => validateSubtree({ profile: "no-such-profile" }), ConfigError);
    });
});

describe("validateSubtree", () => {
    it("accepts the full documented shape", () => {
        const subtree = validateSubtree({
            targets: ["https://example.com/"],
            fetch: "auto",
            scope: "origin",
            concurrency: 0,
            rate: 0,
            "max-pages": 0,
            "max-depth": 0,
            resources: { fetch: true, "max-per-page": 200 },
            links: { exclude: ["linkedin.com"] },
            proxy: "",
            robots: true,
            sitemap: true,
            fold: { threshold: 0.8, min: 3 },
            cache: { pages: { ttl: 0 }, probes: { ttl: "7d" }, robots: { ttl: "24h" }, resources: { "failure-ttl": "10m" } },
            "fail-on": "error",
            format: "human",
            plugins: [],
            "exclude-rules": ["html/canonical-self"],
            override: { error: ["html/one-h1"], warning: ["http/hsts"], info: ["html/title-length"] },
            groups: { posts: { match: ["/posts/**"], rules: ["seo"] } },
            rulesets: { custom: { extends: ["seo"], rules: { "x/y": "warning" } } },
        });
        assert.equal(subtree.fetch, "auto");
    });

    it("rejects an unknown top-level key", () => {
        assert.throws(() => validateSubtree({ taregts: [] }), /org\.spiderlint: unknown key "taregts"/);
    });

    it("names the path of a misspelt nested key", () => {
        assert.throws(() => validateSubtree({ groups: { posts: { mtach: ["/posts/**"] } } }), /org\.spiderlint\/groups\/posts: unknown key "mtach"/);
    });

    it("rejects fold false spelled as a non-const value", () => {
        assert.throws(() => validateSubtree({ fold: "off" }), ConfigError);
    });

    it("rejects an unknown override bucket", () => {
        assert.throws(() => validateSubtree({ override: { critical: ["html/one-h1"] } }), /org\.spiderlint\/override: unknown key "critical"/);
    });
});

describe("environmentSettings", () => {
    it("reads only the variables that are set", () => {
        const settings = environmentSettings({ SPIDERLINT_FETCH: "browser", SPIDERLINT_MAX_PAGES: "5" });
        assert.deepEqual(settings, { fetch: "browser", maxPages: 5 });
    });

    it("parses lists, booleans and fold", () => {
        const settings = environmentSettings({ SPIDERLINT_TARGETS: "https://a/, https://b/", SPIDERLINT_RULES: "seo,tls", SPIDERLINT_ROBOTS: "off", SPIDERLINT_FOLD: "false" });
        assert.deepEqual(settings, { seeds: ["https://a/", "https://b/"], rules: ["seo", "tls"], robots: false, fold: false });
    });

    it("rejects an invalid enum value by name", () => {
        assert.throws(() => environmentSettings({ SPIDERLINT_SCOPE: "planet" }), /SPIDERLINT_SCOPE: invalid value planet/);
    });

    it("rejects a non-integer count", () => {
        assert.throws(() => environmentSettings({ SPIDERLINT_MAX_DEPTH: "deep" }), /SPIDERLINT_MAX_DEPTH: invalid value deep/);
    });

    it("keeps only the origin of canonical-origin and rejects anything but an absolute http URL", () => {
        assert.deepEqual(environmentSettings({ SPIDERLINT_CANONICAL_ORIGIN: "https://dbuho.me/posts/?x=1" }), { canonicalOrigin: "https://dbuho.me" });
        assert.throws(() => environmentSettings({ SPIDERLINT_CANONICAL_ORIGIN: "dbuho.me" }), /SPIDERLINT_CANONICAL_ORIGIN: invalid value dbuho\.me/);
        assert.throws(() => environmentSettings({ SPIDERLINT_CANONICAL_ORIGIN: "ftp://dbuho.me" }), ConfigError);
    });

    it("parses excluded rules and merges the three override buckets", () => {
        const settings = environmentSettings({
            SPIDERLINT_EXCLUDE_RULES: "html/canonical-self,http/hsts",
            SPIDERLINT_OVERRIDE_ERROR: "html/one-h1",
            SPIDERLINT_OVERRIDE_INFO: "html/one-h1 html/title-length",
        });
        assert.deepEqual(settings, {
            excludeRules: ["html/canonical-self", "http/hsts"],
            overrides: { "html/one-h1": "info", "html/title-length": "info" },
        });
    });
});

describe("loadSettings", () => {
    let directory: string;

    before(() => {
        directory = temporaryDirectory();
    });

    after(() => rmSync(directory, { recursive: true, force: true }));

    it("errors on an explicit file that does not exist", () => {
        assert.throws(() => loadSettings(path.join(directory, "nope.yaml")), /config file not found/);
    });

    it("reads the org.spiderlint subtree of an explicit projectfile via pf-cli", () => {
        const file = path.join(directory, "explicit.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    targets: [https://f.dbuho.me/]", "    fetch: browser", "    max-pages: 50", "    groups:", "      posts:", "        match: [/posts/**]"].join("\n"));
        const { settings, document } = loadSettings(file);
        assert.equal(document, file);
        assert.deepEqual(settings.seeds, ["https://f.dbuho.me/"]);
        assert.equal(settings.fetch, "browser");
        assert.equal(settings.maxPages, 50);
        assert.deepEqual(settings.groups, { posts: { match: ["/posts/**"] } });
    });

    it("reads exclude-rules and flattens the override buckets via pf-cli", () => {
        const file = path.join(directory, "overrides.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    exclude-rules: [html/canonical-self]", "    override:", "      error: [html/one-h1]", "      warning: [http/hsts]"].join("\n"));
        const { settings } = loadSettings(file);
        assert.deepEqual(settings.excludeRules, ["html/canonical-self"]);
        assert.deepEqual(settings.overrides, { "html/one-h1": "error", "http/hsts": "warning" });
    });

    it("reads each sites.<name> as its own settings over the shared ones", () => {
        const file = path.join(directory, "sites.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    max-pages: 5", "    sites:", "      static:", "        targets: [https://beta.dbuho.me/]", "        canonical-origin: https://dbuho.me", "      preview:", "        targets: [https://f.dbuho.me/]", "        fetch: browser"].join("\n"));
        const { settings, sites } = loadSettings(file);
        assert.deepEqual(settings, { maxPages: 5 });
        assert.deepEqual(sites, { static: { seeds: ["https://beta.dbuho.me/"], canonicalOrigin: "https://dbuho.me" }, preview: { seeds: ["https://f.dbuho.me/"], fetch: "browser" } });
    });

    it("keeps unknown object keys for plugins, a site replacing only the plugin keys it sets", () => {
        const file = path.join(directory, "plugin-keys.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    images: { weight: 5 }", "    other: { x: 1 }", "    sites:", "      a:", "        targets: [https://a.test/]", "        images: { oversize: 3 }"].join("\n"));
        const { settings, sites } = loadSettings(file);
        assert.deepEqual(settings, { pluginSettings: { images: { weight: 5 }, other: { x: 1 } } });
        assert.deepEqual(sites.a?.pluginSettings, { images: { oversize: 3 }, other: { x: 1 } });
    });

    it("rejects shared targets beside sites", () => {
        const file = path.join(directory, "sites-targets.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    targets: [https://a.test/]", "    sites:", "      b:", "        targets: [https://b.test/]"].join("\n"));
        assert.throws(() => loadSettings(file), /org\.spiderlint\/targets: with sites/);
    });

    it("rejects a misspelt key inside a site", () => {
        const file = path.join(directory, "sites-bad.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    sites:", "      b:", "        tragets: [https://b.test/]"].join("\n"));
        assert.throws(() => loadSettings(file), /org\.spiderlint\/sites\/b: unknown key "tragets"/);
    });

    it("surfaces a misspelt nested key as a ConfigError naming its path", () => {
        const file = path.join(directory, "bad.yaml");
        writeFileSync(file, ["org:", "  spiderlint:", "    groups:", "      posts:", "        mtach: [/posts/**]"].join("\n"));
        assert.throws(() => loadSettings(file), /org\.spiderlint\/groups\/posts: unknown key "mtach"/);
    });

    it("returns empty settings with no document when nothing is discoverable", () => {
        const empty = temporaryDirectory();
        try {
            process.chdir(empty);
            const { settings, document } = loadSettings(undefined);
            assert.deepEqual(settings, {});
            assert.equal(document, undefined);
        } finally {
            process.chdir(ORIGINAL_CWD);
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it("skips a discovered file with no pf-cli on PATH", () => {
        const found = temporaryDirectory();
        writeFileSync(path.join(found, "projectfile.yaml"), "org:\n  spiderlint:\n    fetch: browser\n");
        try {
            process.chdir(found);
            withoutPfCli(() => {
                const { settings, document } = loadSettings(undefined);
                assert.deepEqual(settings, {});
                assert.equal(document, "projectfile.yaml");
            });
        } finally {
            process.chdir(ORIGINAL_CWD);
            rmSync(found, { recursive: true, force: true });
        }
    });

    it("parses an explicit file directly with no pf-cli on PATH", () => {
        const file = path.join(directory, "plain.yaml");
        writeFileSync(file, "org:\n  spiderlint:\n    fetch: browser\n    max-pages: 3\n");
        withoutPfCli(() => {
            const { settings } = loadSettings(file);
            assert.deepEqual(settings, { fetch: "browser", maxPages: 3 });
        });
    });

    it("reads a projectfile without org.spiderlint as no settings", () => {
        const file = path.join(directory, "bare.yaml");
        writeFileSync(file, "identity:\n  name: demo\n");
        withFakePfCli("echo null; exit 1", () => {
            assert.deepEqual(loadSettings(file).settings, {});
        });
    });

    it("surfaces a pf-cli failure as a ConfigError", () => {
        const file = path.join(directory, "broken.yaml");
        writeFileSync(file, "org:\n  spiderlint:\n    fetch: browser\n");
        withFakePfCli('echo "boom" >&2; exit 1', () => {
            assert.throws(() => loadSettings(file), /pf-cli: cannot read org\.spiderlint/);
        });
    });
});
