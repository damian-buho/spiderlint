// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Origin } from "./origin.ts";

type File = [status: number, type: string, body: string, headers?: Record<string, string>];

const DAY_MS = 86_400_000;
const JSON_TYPE = "application/json";
const HTML = "text/html; charset=utf-8";

// Every file valid, a page linking only registered suffixes.
function valid(origin: string): Record<string, File> {
    const expires = new Date(Date.now() + 180 * DAY_MS).toISOString();
    return {
        "/": [
            200,
            HTML,
            '<!DOCTYPE html><html lang="en"><head><title>Home</title><link rel="alternate" type="text/markdown" href="/index.md"></head><body><h1>Home</h1><form><input type="password" autocomplete="current-password"></form><a href="/page">Page</a><a href="/.well-known/security.txt">Security</a></body></html>',
        ],
        "/page": [200, HTML, '<!DOCTYPE html><html lang="en"><head><title>Page</title></head><body><h1>Page</h1></body></html>'],
        "/index.md": [200, "text/markdown", "# Home\n"],
        "/page.md": [200, "text/markdown", "# Page\n"],
        "/.well-known/security.txt": [200, "text/plain; charset=utf-8", `# Contact us\nContact: mailto:security@example.test\nExpires: ${expires}\nCanonical: ${origin}/.well-known/security.txt\nPreferred-Languages: en, uk\n`],
        "/.well-known/change-password": [302, HTML, "", { location: "/page" }],
        "/.well-known/gpc.json": [200, JSON_TYPE, '{"gpc": true, "lastUpdate": "2026-01-01"}'],
        "/.well-known/api-catalog": [200, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"', `{"linkset": [{"anchor": "${origin}/api"}]}`],
        "/.well-known/openid-configuration": [200, JSON_TYPE, JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/auth`, jwks_uri: `${origin}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["ES256"] })],
        "/.well-known/oauth-authorization-server": [200, JSON_TYPE, JSON.stringify({ issuer: origin, response_types_supported: ["code"] })],
        "/.well-known/oauth-protected-resource": [200, JSON_TYPE, JSON.stringify({ resource: origin })],
        "/.well-known/webauthn": [200, JSON_TYPE, '{"origins": ["https://example.test"]}'],
        "/.well-known/apple-app-site-association": [200, JSON_TYPE, '{"applinks": {"details": []}}'],
        "/.well-known/assetlinks.json": [200, JSON_TYPE, '[{"relation": ["delegate_permission/common.handle_all_urls"], "target": {"namespace": "web", "site": "https://example.test"}}]'],
        // eslint-disable-next-line unicorn/prefer-https -- the nodeinfo schema rel is an http: identifier by definition
        "/.well-known/nodeinfo": [200, JSON_TYPE, JSON.stringify({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `${origin}/nodeinfo/2.1` }] })],
        "/nodeinfo/2.1": [200, JSON_TYPE, '{"version": "2.1"}'],
        "/.well-known/traffic-advice": [200, "application/trafficadvice+json", '[{"user_agent": "prefetch-proxy", "fraction": 0.5}]'],
        "/.well-known/webfinger": [400, "text/plain", "resource required"],
        "/.well-known/tdmrep.json": [200, JSON_TYPE, '[{"location": "/*", "tdm-reservation": 1}]'],
        "/llms.txt": [200, "text/markdown", "# Home\n\n> A fixture.\n\n- [Page](/page)\n"],
        "/llms-full.txt": [200, "text/markdown", "# Home\n\nEverything.\n"],
        "/.well-known/agent-card.json": [
            200,
            JSON_TYPE,
            JSON.stringify({
                name: "a",
                description: "d",
                version: "1",
                supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
                capabilities: {},
                defaultInputModes: ["text/plain"],
                defaultOutputModes: ["text/plain"],
                skills: [{ id: "s", name: "s", description: "d", tags: [] }],
            }),
        ],
        "/.well-known/ai-catalog.json": [200, JSON_TYPE, JSON.stringify({ specVersion: "1.0", host: { name: "fixture" }, entries: [{ identifier: "urn:fixture:a", displayName: "A", mediaType: JSON_TYPE, url: `${origin}/a` }] })],
        "/.well-known/mcp/server-card.json": [200, JSON_TYPE, '{"name": "fixture", "version": "1.0.0"}'],
        "/.well-known/agent-skills/index.json": [200, JSON_TYPE, JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills: [{ name: "s", type: "skill", description: "d", url: "/s/SKILL.md", digest: "sha256:0" }] })],
        "/okf/index.md": [200, "text/markdown", "---\ntype: index\nokf_version: 0.2\n---\n# Fixture\n"],
        "/carbon.txt": [200, "text/plain", `version = "0.5"\nlast_updated = ${new Date().toISOString().slice(0, 10)}\n\n[org]\ndisclosures = [{ doc_type = "web-page", url = "${origin}/page" }]\n\n[upstream]\nservices = [{ domain = "hosting.example", service_type = "shared-hosting" }]\n`],
        "/schemamap.xml": [200, "application/xml", '<?xml version="1.0" encoding="UTF-8"?><schemamap xmlns="https://example.com/schemas/schemamap/0.1"><resource><loc>/</loc></resource></schemamap>'],
    };
}

// Every file present and malformed; a password field with no change-password, and an unregistered suffix.
function broken(origin: string): Record<string, File> {
    const expires = new Date(Date.now() + 800 * DAY_MS).toISOString();
    return {
        "/": [200, HTML, '<!DOCTYPE html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1><input type="Password"><a href="/missing">Missing</a><a href="/.well-known/made-up">Made up</a></body></html>'],
        "/.well-known/security.txt": [200, "text/plain", `Contact: nope\nthis is not a field\nExpires: ${expires}\nCanonical: https://elsewhere.test/.well-known/security.txt\n`],
        "/.well-known/gpc.json": [200, JSON_TYPE, '{"gpc": "yes", "lastUpdate": "soon"}'],
        "/.well-known/api-catalog": [200, JSON_TYPE, '{"links": []}'],
        "/.well-known/openid-configuration": [200, JSON_TYPE, '{"issuer": "https://elsewhere.test"}'],
        "/.well-known/oauth-authorization-server": [200, JSON_TYPE, "{"],
        "/.well-known/oauth-protected-resource": [200, JSON_TYPE, '{"resource": "https://elsewhere.test"}'],
        // eslint-disable-next-line unicorn/prefer-https -- the nodeinfo schema rel is an http: identifier by definition
        "/.well-known/webauthn": [200, JSON_TYPE, '{"origins": ["http://example.test/path"]}'],
        "/.well-known/apple-app-site-association": [301, "text/plain", "", { location: "/aasa" }],
        "/aasa": [200, "text/plain", '{"applinks": {}}'],
        "/.well-known/assetlinks.json": [200, JSON_TYPE, '{"relation": []}'],
        // eslint-disable-next-line unicorn/prefer-https -- a plain http origin is the defect this file carries
        "/.well-known/nodeinfo": [200, JSON_TYPE, JSON.stringify({ links: [{ rel: "http://nodeinfo.diaspora.software/ns/schema/2.1", href: `${origin}/nodeinfo/gone` }] })],
        "/.well-known/traffic-advice": [200, JSON_TYPE, '[{"user_agent": "prefetch-proxy", "fraction": 2}]'],
        "/.well-known/tdmrep.json": [200, JSON_TYPE, '[{"location": "/*", "tdm-reservation": "yes"}]'],
        "/llms.txt": [200, "text/plain", `Intro first\n# One\n# Two\n- [Missing](/missing)\n- [Gone](/uncrawled)\n- [Referenced][gone]\n- <${origin}/gone-auto>\n\n[gone]: /gone-ref\n`],
        "/llms-full.txt": [200, "application/octet-stream", `Preamble\n\n# Full\n\n[Missing](/missing), [referenced][gone] and <${origin}/gone-auto>.\n\n\`\`\`sh\n# a comment, not a heading\n\`\`\`\n\n[gone]: /gone-ref\n`],
        "/.well-known/agent-card.json": [200, JSON_TYPE, '{"name": "a", "skills": [{"id": "s"}]}'],
        "/.well-known/ai-catalog.json": [200, JSON_TYPE, '{"specVersion": "1.0", "entries": [{"identifier": "urn:a", "displayName": "A"}]}'],
        "/.well-known/mcp/server-card.json": [200, JSON_TYPE, "[]"],
        "/.well-known/agent-skills/index.json": [200, JSON_TYPE, '{"skills": [{"name": "s"}]}'],
        "/okf/index.md": [200, "text/markdown", "# No front matter\n"],
        "/schemamap.xml": [200, "text/plain", "<urlset/>"],
        "/.well-known/carbon.txt": [200, "text/plain", `version = "9.9"\nlast_updated = 2020-01-01\n\n[org]\ndisclosures = [{ doc_type = "blog", url = "${origin}/missing" }, { doc_type = "annual-report", url = "${origin}/", valid_until = 2021-01-01 }]\n`],
    };
}

// Only a home page and a valid llms.txt, with no llms-full.txt.
function lean(): Record<string, File> {
    return {
        "/": [200, HTML, '<!DOCTYPE html><html lang="en"><head><title>Home</title></head><body><h1>Home</h1></body></html>'],
        "/llms.txt": [200, "text/markdown", "# Home\n\n> A fixture.\n\n- [Home](/)\n"],
    };
}

// An origin serving every well-known and agent file, `valid` or `broken`, `lean` serving llms.txt alone, `withheld` being `broken` behind a robots.txt disallowing `/.well-known/`; anything else is an HTML 404.
export async function serveWellKnown(kind: "valid" | "broken" | "withheld" | "lean"): Promise<Origin> {
    const requested: string[] = [];
    let files: Record<string, File> = {};
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://origin").pathname;
        requested.push(pathname);
        const [status, type, body, headers] = files[pathname] ?? [404, HTML, "<!DOCTYPE html><title>Not found</title>"];
        response.writeHead(status, { "content-type": type, ...headers });
        response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    files = kind === "valid" ? valid(origin) : kind === "lean" ? lean() : broken(origin);
    if (kind === "withheld") files["/robots.txt"] = [200, "text/plain", "User-agent: *\nDisallow: /.well-known/\n"];
    return { origin, requested, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
