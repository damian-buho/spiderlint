// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { audit, type Report } from "../src/index.ts";
import { serveOrigin, type Origin } from "./fixtures/origin.ts";
import { serveFixture, type Fixture } from "./fixtures/server.ts";
import { serveWellKnown } from "./fixtures/well-known.ts";

const EXCLUDE = ["/tmp/**"];

// Rule IDs of a report’s findings, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("well-known plugin", () => {
    let site: Fixture;
    let valid: Origin;
    let broken: Origin;
    let soft: Origin;

    before(async () => {
        [site, valid, broken, soft] = await Promise.all([serveFixture(), serveWellKnown("valid"), serveWellKnown("broken"), serveOrigin("soft")]);
    });

    after(() => Promise.all([site.close(), valid.close(), broken.close(), soft.close()]));

    it("passes every present file on a valid origin", async () => {
        const report = await audit({ seeds: [`${valid.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), []);
        assert.ok(report.summary.checks.total >= 15, `${report.summary.checks.total} checks`);
    });

    it("faults every malformed file, the missing change-password and an unregistered suffix", async () => {
        const report = await audit({ seeds: [`${broken.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        const expected = [
            "agent-card/invalid",
            "agent-skills/invalid",
            "ai-catalog/invalid",
            "api-catalog/invalid",
            "apple-app-site-association/invalid",
            "assetlinks/invalid",
            "change-password/missing",
            "gpc/invalid",
            "llms-full-txt-markdown/invalid",
            "llms-full-txt/invalid",
            "llms-txt-markdown/invalid",
            "llms-txt/invalid",
            "markdown-source/missing",
            "mcp-server-card/invalid",
            "nodeinfo/invalid",
            "oauth-authorization-server/invalid",
            "oauth-protected-resource/invalid",
            "okf/invalid",
            "openid-configuration/invalid",
            "schemamap/invalid",
            "security-txt-expires/invalid",
            "security-txt/invalid",
            "suffix/unknown",
            "tdmrep/invalid",
            "traffic-advice/invalid",
            "webauthn/invalid",
        ];
        assert.deepEqual(
            rules(report),
            expected.map((id) => `well-known/${id}`),
        );
        const message = (id: string): string => report.findings.find((finding) => finding.rule === `well-known/${id}`)?.message ?? "";
        assert.match(message("security-txt/invalid"), /line 2 is not a field.*Contact nope is not a URI/);
        assert.match(message("suffix/unknown"), /“made-up”/);
        assert.match(message("llms-txt-markdown/invalid"), /4:1 no-alt-text/);
        assert.match(message("llms-full-txt-markdown/invalid"), /5:1 no-reversed-links/);
        const agents = report.site.origins?.[broken.origin]?.agents as Record<string, { errors: string[] }>;
        const errors = (key: string): string => agents[key]?.errors.join("\n") ?? "";
        for (const key of ["llms-txt", "llms-full-txt"]) for (const link of ["/missing", "/gone-ref", "/gone-auto"]) assert.match(errors(key), new RegExp(`${link} answers 404`), `${key} names ${link}`);
        assert.match(errors("llms-txt"), /\/uncrawled answers 404/);
        assert.match(errors("llms-full-txt"), /served as application\/octet-stream[^]*does not open with its H1/);
        assert.doesNotMatch(errors("llms-full-txt"), /H1 headings/, "a # inside a code fence is no heading");
    });

    it("advises llms-full.txt beside an llms.txt only", async () => {
        const lean = await serveWellKnown("lean");
        try {
            const report = await audit({ seeds: [`${lean.origin}/`], rules: ["agents"], cacheMode: "off" });
            assert.deepEqual(rules(report), ["well-known/llms-full-txt/missing", "well-known/markdown-source/missing"]);
        } finally {
            await lean.close();
        }
    });

    it("probes at most max-links uncrawled links per file and counts the rest", async () => {
        const report = await audit({ seeds: [`${broken.origin}/`], rules: ["agents"], cacheMode: "off", pluginSettings: { "well-known": { "max-links": 1 } } });
        const full = (report.site.origins?.[broken.origin]?.agents as Record<string, { fields: { links: number; probed: number; unprobed: number } }>)["llms-full-txt"]?.fields;
        assert.deepEqual([full?.links, full?.probed, full?.unprobed], [3, 1, 1]);
    });

    it("reports only the absent security.txt, llms.txt and Markdown sources where every other file is missing", async () => {
        const report = await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["well-known/llms-txt/missing", "well-known/markdown-source/missing", "well-known/security-txt/missing"]);
    });

    it("sends no probe robots.txt disallows and judges none of those files", async () => {
        const withheld = await serveWellKnown("withheld");
        try {
            const report = await audit({ seeds: [`${withheld.origin}/`], rules: ["well-known"], cacheMode: "off" });
            assert.deepEqual(rules(report), ["well-known/suffix/unknown"]);
            assert.deepEqual(
                withheld.requested.filter((requested) => requested.startsWith("/.well-known/")),
                [],
            );
        } finally {
            await withheld.close();
        }
    });

    it("probes every file with robots.txt off", async () => {
        const withheld = await serveWellKnown("withheld");
        try {
            const report = await audit({ seeds: [`${withheld.origin}/`], rules: ["well-known"], robots: false, cacheMode: "off" });
            assert.ok(rules(report).includes("well-known/security-txt/invalid"));
        } finally {
            await withheld.close();
        }
    });

    it("takes a soft 404’s HTML for absence, not for malformed files", async () => {
        const report = await audit({ seeds: [`${soft.origin}/`], rules: ["well-known", "agents"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["well-known/llms-txt/missing", "well-known/markdown-source/missing", "well-known/security-txt/missing"]);
    });

    it("probes a broken uncrawled llms.txt link again on every run", async () => {
        const cache = await mkdtemp(path.join(tmpdir(), "spiderlint-llms-"));
        const saved = process.env.XDG_CACHE_HOME;
        process.env.XDG_CACHE_HOME = cache;
        try {
            const options = { seeds: [`${broken.origin}/`], rules: ["agents"], cacheTtl: { origins: 0 } };
            await audit(options);
            const before = broken.requested.length;
            const report = await audit(options);
            const requested = new Set(broken.requested.slice(before));
            assert.ok(requested.has("/llms.txt"), "the agents extractor ran again");
            assert.ok(requested.has("/uncrawled"), "a broken answer is never stored");
            assert.match(report.findings.find((finding) => finding.rule === "well-known/llms-txt/invalid")?.message ?? "", /\/uncrawled answers 404/);
        } finally {
            if (saved === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = saved;
            await rm(cache, { recursive: true, force: true });
        }
    });

    it("records a Markdown twin on the sampled pages only", async () => {
        const before = valid.requested.length;
        const report = await audit({ seeds: [`${valid.origin}/`], groups: { default: { rules: ["agents"], sample: 1 } }, cacheMode: "off" });
        const sources = report.pages.flatMap((page) => (page.markdown ? [page.markdown as { present: boolean; twin: { url: string } }] : []));
        assert.deepEqual(
            sources.map((source) => [source.present, new URL(source.twin.url).pathname]),
            [[true, "/index.md"]],
        );
        assert.ok(!valid.requested.slice(before).includes("/page.md"));
        assert.deepEqual(rules(report), []);
    });

    it("finds a directory page’s stripped sibling twin with no advertised alternate", async () => {
        const { createServer } = await import("node:http");
        const server = createServer((request, response) => {
            const pathname = new URL(request.url ?? "/", "http://origin").pathname;
            if (pathname === "/dir/") {
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                response.end('<!DOCTYPE html><html lang="en"><head><title>Dir</title></head><body><h1>Dir</h1></body></html>');
            } else if (pathname === "/dir.md") {
                response.writeHead(200, { "content-type": "text/markdown" });
                response.end("# Dir\n");
            } else {
                response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
                response.end("<!DOCTYPE html><title>Not found</title>");
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        try {
            const report = await audit({ seeds: [`${origin}/dir/`], rules: ["agents"], cacheMode: "off" });
            const source = report.pages.flatMap((page) => (page.url.pathname === "/dir/" && page.markdown ? [page.markdown as { present: boolean; twin: { url: string } }] : []));
            assert.deepEqual(
                source.map((entry) => [entry.present, new URL(entry.twin.url).pathname]),
                [[true, "/dir.md"]],
            );
            assert.ok(!rules(report).includes("well-known/markdown-source/missing"));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("probes only the files of the enabled preset", async () => {
        const before = site.requested.length;
        await audit({ seeds: [`${site.origin}/`], excludeUrls: EXCLUDE, rules: ["well-known:security"], cacheMode: "off" });
        const probed = new Set(site.requested.slice(before));
        assert.ok(probed.has("/.well-known/security.txt"));
        assert.ok(!probed.has("/llms.txt"));
    });
});
