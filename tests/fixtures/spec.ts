// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SpecSite {
    origin: string;
    close(): Promise<void>;
}

const HTML = "text/html; charset=utf-8";
const RSS = "application/rss+xml";
const JSON_FEED = "application/feed+json";
const MANIFEST = "application/manifest+json";

// Each path with its content type and body, `ORIGIN` standing for the served origin.
const FILES: Record<string, [string, string]> = {
    "/good": [
        HTML,
        `<!DOCTYPE html><html lang="en"><head><title>Good</title>
<link rel="alternate" hreflang="en" href="/good"><link rel="alternate" hreflang="es-ES" href="/es/">
<link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml"><link rel="alternate" type="application/feed+json" href="/feed.json">
<link rel="manifest" href="/good.webmanifest">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Widget"},{"@type":"WebPage","@id":"ORIGIN/good#page","url":"ORIGIN/good","name":"Good"},{"@type":"Organization","@id":"ORIGIN/#org","name":"Acme"},{"@type":"BlogPosting","headline":"Good","datePublished":"2026-09-01T10:00:00Z","dateModified":"2026-09-02T10:00:00Z","publisher":{"@id":"ORIGIN/#org"}},{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"ORIGIN/good"}]}]}</script>
</head><body><h1>Good</h1>
<div itemscope itemtype="https://schema.org/Person" itemid="ORIGIN/#me"><span itemprop="name">Ana</span></div>
<div vocab="https://schema.org/" typeof="Event"><span property="name">Talk</span> <time property="startDate" datetime="2026-10-01">1 October</time> <span property="location" typeof="Place"><span property="name">Hall</span></span></div>
<a href="/es/" lang="es" hreflang="es-ES">Español</a> <a href="/bad">The broken page</a> <a href="/de" aria-label="Read more in German">Read more</a> <a href="#main">Skip to content</a> <a href="/good">Good</a>
<video src="/talk.mp4" controls><track kind="captions" src="/talk.vtt" srclang="en"></video>
<video src="/loop.mp4" autoplay muted loop></video>
<input type="email" autocomplete="email"><input type="text" inputmode="tel" autocomplete="billing tel">
</body></html>`,
    ],
    "/bad": [
        HTML,
        `<!DOCTYPE html><html lang="en-GB"><head><title>Bad</title>
<link rel="alternate" hreflang="es" href="/es/">
<link rel="manifest" href="/bad.webmanifest">
<script type="application/ld+json">{"@type": "Event", "name": "Launch"}</script>
<script type="application/ld+json">{"@type": "Event", "name": "Oops",}</script>
<script type="application/ld+json">{"@type": "BreadcrumbList", "itemListElement": [{"@type": "ListItem", "position": 1, "item": {"@id": "/gone"}}, {"@type": "ListItem", "position": 2, "item": "/moved"}]}</script>
<script type="application/ld+json">[{"@type": "WebPage", "url": "/elsewhere", "name": "Something else", "isPartOf": {"@id": "ORIGIN/good#page"}}, {"@type": "Article", "headline": "Bad", "author": {"@id": "#nobody"}, "datePublished": "2026-09-02", "dateModified": "2026-09-01", "dateCreated": "yesterday"}, {"@type": "Corporation", "@id": "ORIGIN/#org", "name": "Acme"}, {"@type": "Person", "@id": "ORIGIN/bad#me", "name": "Ana"}]</script>
</head><body><h1>Bad</h1>
<div itemscope itemtype="https://schema.org/Recipe"><span itemprop="name">Soup</span> <span itemprop="ingredients">Water</span></div>
<div vocab="https://schema.org/" typeof="Taxi"><span property="name">Cab</span></div>
<a href="/es/">Español</a> <a href="/gone">Click here!</a> <a href="/moved">The moved page</a>
<a href="/bad.xml">Broken feed</a> <a href="/noid.xml">Feed without ids</a> <a href="/hub.json">Hub feed</a> <a href="/elsewhere.xml">Feed of another URL</a>
<video src="/talk.mp4" controls></video>
<input type="text" autocomplete="email">
</body></html>`,
    ],
    "/es/": [HTML, `<!DOCTYPE html><html lang="es"><head><title>Bueno</title><link rel="manifest" href="/broken.webmanifest"></head><body><h1>Bueno</h1><a href="/good">Leer más…</a></body></html>`],
    "/de": [HTML, `<!DOCTYPE html><html lang="de"><head><title>Gut</title></head><body><h1>Gut</h1><a href="/good">Hier klicken</a></body></html>`],
    "/feed.xml": [RSS, `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Good</title><atom:link rel="self" href="ORIGIN/feed.xml"/><atom:link rel="hub" href="https://hub.example/"/><item><title>One</title><guid>one</guid></item></channel></rss>`],
    "/atom.xml": ["application/atom+xml", `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Good</title><id>urn:good</id><link rel="self" href="/atom.xml"/><entry><title>One</title><id>urn:one</id></entry></feed>`],
    "/feed.json": [JSON_FEED, `{"version":"https://jsonfeed.org/version/1.1","title":"Good","feed_url":"ORIGIN/feed.json","items":[{"id":"1","content_text":"One"}]}`],
    "/bad.xml": [RSS, `<?xml version="1.0"?><rss version="2.0"><channel><title>A & B</title></channel></rss>`],
    "/noid.xml": [RSS, `<?xml version="1.0"?><rss version="2.0"><channel><title>No ids</title><item><title>One</title><guid>one</guid></item><item><title>Two</title></item></channel></rss>`],
    "/hub.json": [JSON_FEED, `{"version":"https://jsonfeed.org/version/1.1","title":"Hub","hubs":[{"type":"WebSub","url":"https://hub.example/"}],"items":[{"id":"1"}]}`],
    "/elsewhere.xml": ["application/atom+xml", `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Moved</title><id>urn:moved</id><link rel="self" href="https://feeds.example/atom.xml"/></feed>`],
    "/good.webmanifest": [MANIFEST, `{"name":"Good","id":"/","start_url":"/","scope":"/","display":"standalone","icons":[{"src":"/192.png","sizes":"192x192"},{"src":"/512.png","sizes":"512x512","purpose":"any maskable"}]}`],
    "/bad.webmanifest": ["application/json", `{"name":"Bad","scope":"https://elsewhere.example/","icons":[{"src":"/16.png","sizes":"16x16"}]}`],
    "/broken.webmanifest": [MANIFEST, `{"name":`],
};

// Serves FILES, `/moved` as a 301 to `/good`, anything else as an HTML 404.
export async function serveSpec(): Promise<SpecSite> {
    let origin = "";
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://spec").pathname;
        const file = FILES[pathname];
        if (pathname === "/moved") response.writeHead(301, { location: "/good" }).end();
        else if (file) response.writeHead(200, { "content-type": file[0] }).end(file[1].replaceAll("ORIGIN", () => origin));
        else response.writeHead(404, { "content-type": HTML }).end('<!DOCTYPE html><html lang="en"><title>Not found</title></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
