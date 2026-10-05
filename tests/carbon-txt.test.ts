// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Bucket, type BucketName } from "../src/cache/index.ts";
import { dnsClient, type StoredReply } from "../src/crawl/dns.ts";
import { probe } from "../src/crawl/probe.ts";
import type { Facts } from "../src/facts/types.ts";
import { audit, type Report } from "../src/index.ts";
import { checkCarbonTxt } from "../src/plugins/carbon-txt.ts";
import type { SiteContext } from "../src/plugins/types.ts";
import wellKnown from "../src/plugins/well-known.ts";
import { serveDns, setZone, type DnsFixture } from "./fixtures/dns.ts";
import type { Origin } from "./fixtures/origin.ts";
import { serveWellKnown } from "./fixtures/well-known.ts";

const NOW = Date.UTC(2026, 8, 27);
const VALID = 'version = "0.5"\nlast_updated = 2026-09-01\n[org]\ndisclosures = [{ doc_type = "web-page", url = "https://example.org/green" }]\n';
const errors = (text: string) => checkCarbonTxt(text, NOW).errors;

describe("carbon.txt validator", () => {
    it("passes a valid file and keeps its fields", () => {
        const verdict = checkCarbonTxt(VALID, NOW);
        assert.deepEqual(verdict.errors, []);
        assert.deepEqual(verdict.links, ["https://example.org/green"]);
        assert.deepEqual(verdict.fields, { version: "0.5", last_updated: "2026-09-01T00:00:00.000Z", org: { disclosures: [{ doc_type: "web-page", url: "https://example.org/green" }] }, upstream: { services: [] } });
        assert.equal(verdict["age-days"], 26);
    });

    it("names each defect on one line", () => {
        assert.match(errors("version = ")[0] ?? "", /^not TOML: /);
        assert.deepEqual(errors(VALID.replace('version = "0.5"\n', "")), ["version missing"]);
        assert.deepEqual(errors(VALID.replace('"0.5"', '"0.9"')), ["version 0.9 is unknown"]);
        assert.deepEqual(errors('version = "0.5"\n[org]\ndisclosures = []\n'), ["org.disclosures missing or empty"]);
        assert.deepEqual(errors('version = "0.5"\n'), ["org.disclosures missing or empty"]);
        assert.deepEqual(errors(VALID.replace('doc_type = "web-page", ', "")), ["org.disclosures[0].doc_type missing"]);
        assert.match(errors(VALID.replace('"web-page"', '"blog"'))[0] ?? "", /^org\.disclosures\[0\]\.doc_type blog is not one of web-page, /);
        assert.deepEqual(errors(VALID.replace("https://example.org/green", "ftp://example.org/green")), ["org.disclosures[0].url ftp://example.org/green is not an http: or https: URL"]);
        assert.deepEqual(errors(VALID.replace("2026-09-01", '"last week"')), ["last_updated last week is not a TOML date or RFC 3339 string"]);
        assert.deepEqual(errors(VALID.replace(" }]", ', valid_until = "soon" }]')), ["org.disclosures[0].valid_until soon is not a TOML date or RFC 3339 string"]);
        assert.deepEqual(errors(`${VALID}[upstream]\nservices = ["hosting.example"]\n`), ["upstream.services[0] is not a table"]);
    });

    it("accepts an upstream service without a domain, which syntax 0.5 leaves optional", () => {
        assert.deepEqual(errors(`${VALID}[upstream]\nservices = [{ service_type = "cdn" }]\n`), []);
    });

    it("lists disclosures past their valid_until", () => {
        assert.deepEqual(checkCarbonTxt(VALID.replace(" }]", ", valid_until = 2026-01-01 }]"), NOW).expired, ["https://example.org/green"]);
        assert.deepEqual(checkCarbonTxt(VALID.replace(" }]", ', valid_until = "2027-01-01T00:00:00Z" }]'), NOW).expired, []);
    });
});

// Rule IDs of a report’s findings, sorted.
function rules(report: Report): string[] {
    return report.findings.map((finding) => finding.rule).toSorted((a, b) => a.localeCompare(b));
}

describe("carbon.txt extractor", () => {
    let valid: Origin;
    let broken: Origin;
    let dns: DnsFixture;
    let delegate: Server;
    let target: string;

    before(async () => {
        [valid, broken, dns] = await Promise.all([serveWellKnown("valid"), serveWellKnown("broken"), serveDns()]);
        delegate = createServer((_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end(VALID));
        await new Promise<void>((resolve) => delegate.listen(0, "127.0.0.1", resolve));
        target = `http://127.0.0.1:${(delegate.address() as AddressInfo).port}/shared/carbon.txt`;
    });
    after(() => Promise.all([valid.close(), broken.close(), dns.close(), new Promise((resolve) => delegate.close(resolve))]));

    it("passes the valid file at the root", async () => {
        const report = await audit({ seeds: [`${valid.origin}/`], rules: ["sustainability"], cacheMode: "off" });
        assert.deepEqual(rules(report), []);
        assert.equal((report.site.origins?.[valid.origin]?.["carbon-txt"] as { via: string }).via, "root");
    });

    it("faults the broken file under /.well-known/, expired and stale", async () => {
        const report = await audit({ seeds: [`${broken.origin}/`], rules: ["sustainability"], cacheMode: "off" });
        assert.deepEqual(rules(report), ["well-known/carbon-txt-expired", "well-known/carbon-txt-stale", "well-known/carbon-txt-valid"]);
        const facts = report.site.origins?.[broken.origin]?.["carbon-txt"] as { via: string; errors: string[] };
        assert.equal(facts.via, "well-known");
        assert.ok(
            facts.errors.some((error) => error.endsWith("/missing answers 404")),
            facts.errors.join("; "),
        );
    });

    // A context whose own host serves nothing, reaching `target` only by delegation.
    function context(pages: Facts[] = []): SiteContext {
        const signal = AbortSignal.timeout(10_000);
        const bucket = new Bucket<StoredReply>("dns" as BucketName, undefined, 60, "off");
        return {
            pages,
            signal,
            dns: dnsClient(dns.server, bucket, false),
            fetch: async (url) => ({ url, status: 404, headers: {}, body: "", redirects: [], ms: 0 }),
            delegated: (url, init = {}) => probe(url, init, { host: new URL(url).hostname, allowPrivate: true, signal }),
            link: async () => ({ status: 200 }),
            cached: () => Promise.reject(new Error("no http here")),
            address: async () => "127.0.0.1",
        };
    }
    const extractor = wellKnown.sites?.find((site) => site.id === "carbon-txt");

    it("follows a carbon-txt-location TXT record through the pinned resolver", async () => {
        setZone("carbon.fixture|TXT", { answers: [{ type: "TXT", name: "carbon.fixture", ttl: 300, data: [`carbon-txt-location=${target}`] }] });
        const facts = (await extractor?.extract("https://carbon.fixture", context())) as Record<string, unknown>;
        assert.deepEqual([facts.via, facts.url, facts.present, facts.errors], ["dns", target, true, []]);
        assert.ok(dns.queries.includes("carbon.fixture|TXT"));
    });

    it("follows the seed page’s CarbonTxt-Location header", async () => {
        const seed = { url: { href: "https://header.fixture/" }, crawl: { "discovered-via": "seed" }, http: { headers: { "carbontxt-location": target } } } as unknown as Facts;
        const facts = (await extractor?.extract("https://header.fixture", context([seed]))) as Record<string, unknown>;
        assert.deepEqual([facts.via, facts.url, facts.present], ["header", target, true]);
    });

    it("reports the root answer when nothing is present or delegated", async () => {
        const facts = (await extractor?.extract("https://none.fixture", context())) as Record<string, unknown>;
        assert.deepEqual([facts.via, facts.status, facts.present], ["root", 404, false]);
    });
});
