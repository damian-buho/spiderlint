// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { podcastGuid } from "../../src/plugins/feeds.ts";

export interface FeedSite {
    origin: string;
    close(): Promise<void>;
}

const HTML = "text/html; charset=utf-8";
const RSS = "application/rss+xml; charset=utf-8";
const ATOM = "application/atom+xml";
const JSON_FEED = "application/feed+json";
const POLLED = { etag: '"v1"', "cache-control": "max-age=3600" };
const HEAD = `<link rel="alternate" type="application/rss+xml" href="/feed.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml"><link rel="alternate" type="application/feed+json" href="/feed.json">`;

// A page of the site, `head` added to its head.
const page = (lang: string, title: string, head: string, body: string) => `<!DOCTYPE html><html lang="${lang}"><head><title>${title}</title>${head}</head><body><h1>${title}</h1>${body}</body></html>`;

const MDX = `import Callout from '../components/Callout.astro'

## Why it matters

<Callout type="note">**Bold** claim with a [link](/posts/2).</Callout>`;
const QUOTED = `<p>MDX looks like this:</p><pre><code>import Callout from './Callout'
&lt;Callout&gt;**hi**&lt;/Callout&gt;</code></pre>`;

const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// A long article body, over 150 visible words, so summary-only has a page to judge against.
const LONG = `<p>${"Resilient systems keep working when networks fail and power flickers. ".repeat(30)}</p>`;

// Each path with its status, headers and body, `ORIGIN` standing for the served origin.
const FILES: Record<string, [number, Record<string, string>, string | Buffer]> = {
    "/": [200, { "content-type": HTML }, page("en", "Home", HEAD, `<a href="/about">About</a> <a href="/mdx.xml">MDX</a> <a href="/spec.xml">Spec</a> <a href="/atom-bad.xml">Atom</a> <a href="/old.json">JSON</a> <a href="/plain.xml">Plain</a> <a href="/podcast.xml">Podcast</a> <a href="/joins.xml">Joins</a> <a href="/cast.xml">Cast</a> <a href="/cast-bad.xml">Bad cast</a> <a href="/long-1">Long one</a> <a href="/long-2">Long two</a> <a href="/summary.xml">Summary</a> <a href="/full.xml">Full</a>`)],
    "/about": [200, { "content-type": HTML }, page("en", "About", `<link rel="alternate" type="application/atom+xml" href="/feed.xml"><link rel="alternate" type="application/rss+xml" href="/posts/1">`, "")],
    "/posts/1": [200, { "content-type": HTML }, page("en", "First post", `${HEAD}<link rel="canonical" href="/posts/1"><meta property="article:published_time" content="2026-09-01T10:00:00Z">`, "")],
    "/posts/2": [200, { "content-type": HTML }, page("en", "Another name", `${HEAD}<link rel="canonical" href="/posts/two"><meta property="article:published_time" content="2026-09-20T10:00:00Z"><link rel="alternate" type="application/rss+xml" href="/joins.xml">`, "")],
    "/long-1": [200, { "content-type": HTML }, page("en", "Long one", HEAD, LONG)],
    "/long-2": [200, { "content-type": HTML }, page("en", "Long two", HEAD, LONG)],
    "/old": [301, { location: "/posts/1" }, ""],
    "/feed.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Good</title><link>ORIGIN/</link><description>Everything</description><language>en</language><ttl>60</ttl>
<managingEditor>ana@example.org (Ana Silva)</managingEditor><lastBuildDate>Tue, 15 Sep 2026 10:00:00 +0000</lastBuildDate>
<atom:link rel="self" href="ORIGIN/feed.xml"/>
<item><title>First post</title><link>ORIGIN/posts/1?utm_source=feed&amp;utm_medium=rss</link><guid isPermaLink="false">post-1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered <strong>HTML</strong> with <img src="ORIGIN/a.png" alt=""></p>]]></description>
<content:encoded><![CDATA[${QUOTED}]]></content:encoded></item>
</channel></rss>`],
    "/atom.xml": [200, { "content-type": ATOM, ...POLLED }, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en"><title>Good</title><id>urn:good</id><updated>2026-09-15T10:00:00Z</updated><author><name>Ana</name></author>
<link rel="self" href="ORIGIN/atom.xml"/><link href="ORIGIN/"/>
<entry><title>First post</title><id>urn:one</id><updated>2026-09-01T10:00:00Z</updated><link href="ORIGIN/posts/1"/>
<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Rendered <a href="ORIGIN/posts/1">text</a>.</p></div></content></entry></feed>`],
    "/feed.json": [200, { "content-type": JSON_FEED, ...POLLED }, JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "Good", home_page_url: "ORIGIN/", feed_url: "ORIGIN/feed.json", language: "en", authors: [{ name: "Ana" }], items: [{ id: "1", url: "ORIGIN/posts/1", title: "First post", content_html: "<p>Rendered</p>", date_published: "2026-09-01T10:00:00Z" }] })],
    "/mdx.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>MDX</title><link>ORIGIN/</link><description>Raw</description><atom:link rel="self" href="ORIGIN/mdx.xml"/>
<item><title>Raw post</title><guid isPermaLink="false">raw</guid><content:encoded>${escape(MDX)}</content:encoded></item>
<item><title>Quoting post</title><guid isPermaLink="false">quote</guid><content:encoded><![CDATA[${QUOTED}]]></content:encoded></item>
</channel></rss>`],
    "/spec.xml": [200, { "content-type": "application/rss+xml; charset=iso-8859-1", "cache-control": "no-store" }, `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="/missing.xsl"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:fh="http://purl.org/syndication/history/1.0"><channel>
<title>Spec</title><link>/</link><language>english!!</language><managingEditor>bob</managingEditor><foo>bar</foo><fh:complete/>
<atom:link rel="self" href="ORIGIN/spec.xml"/><atom:link rel="prev-archive" href="ORIGIN/archive-1.xml"/>
<item><title>One</title><link>/posts/1</link><guid>abc</guid><pubDate>2026-09-01</pubDate></item>
<item><title>Two</title><guid>https://example.org/2?utm_source=rss</guid></item>
<item><title>Three</title><guid>https://example.org/2?utm_source=rss</guid><pubDate>Thu, 01 Jan 2099 00:00:00 GMT</pubDate></item>
<item><title>&lt;b&gt;Bold&lt;/b&gt; {{ title }}</title><guid isPermaLink="false">four</guid><description><![CDATA[<p>Hello {{ name }}</p><img src="images/a.png"><script>alert(1)</script><p onclick="x()">&amp;lt;p&amp;gt; and &amp;amp;</p><span>undefined</span>]]></description></item>
</channel></rss>`],
    "/atom-bad.xml": [200, { "content-type": ATOM, ...POLLED }, `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>urn:atom</id><updated>2020-01-06 10:00</updated>
<link rel="self" href="ORIGIN/atom-bad.xml"/><link rel="prev-archive" href="ORIGIN/archive-0.xml"/>
<entry><title>Old</title><id>urn:old</id><published>2020-01-06T10:00:00Z</published><content>&lt;p&gt;Tagged&lt;/p&gt;</content></entry></feed>`],
    "/old.json": [200, { "content-type": "application/json; charset=iso-8859-1", ...POLLED }, JSON.stringify({ version: "https://jsonfeed.org/version/1", title: "Old", feed_url: "ORIGIN/old.json", author: { name: "Ana" }, items: [{ url: "posts/1", content_text: "Plain" }] })],
    "/plain.xml": [200, { "content-type": "text/html", ...POLLED }, `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>Plain</title><link>ORIGIN/</link><description>Plain</description><atom:link rel="self" href="ORIGIN/plain.xml"/></channel></rss>`],
    "/podcast.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Cast</title><link>ORIGIN/</link><description>Cast</description><language>en</language><atom:link rel="self" href="ORIGIN/podcast.xml"/>
<itunes:image href="ORIGIN/cover.jpg"/><itunes:category text="Technology"/><itunes:author>Ana</itunes:author>
<item><title>Episode</title><guid isPermaLink="false">ep1</guid><enclosure url="ORIGIN/ep1.mp3" type="audio/mpeg"/><itunes:duration>1h</itunes:duration></item>
</channel></rss>`],
    "/joins.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Joins</title><link>ORIGIN/</link><description>Joins</description><language>es</language><atom:link rel="self" href="ORIGIN/joins.xml"/>
<item><title>Moved</title><link>ORIGIN/old</link><guid isPermaLink="false">j1</guid></item>
<item><title>Gone</title><link>ORIGIN/missing</link><guid isPermaLink="false">j2</guid></item>
<item><title>Second</title><link>ORIGIN/posts/2</link><guid isPermaLink="false">j3</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`],
    "/cast.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<title>Cast</title><link>ORIGIN/</link><description>Cast</description><language>en</language><ttl>60</ttl>
<managingEditor>ana@example.org (Ana Silva)</managingEditor><lastBuildDate>Tue, 15 Sep 2026 10:00:00 +0000</lastBuildDate>
<atom:link rel="self" href="ORIGIN/cast.xml"/><atom:link rel="hub" href="ORIGIN/hub"/>
<itunes:image href="ORIGIN/cover-good.jpg"/><itunes:category text="Technology"/><itunes:explicit>false</itunes:explicit><itunes:author>Ana</itunes:author>
<podcast:guid>CASTGUID</podcast:guid><podcast:locked>yes</podcast:locked>
<item><title>First post</title><link>ORIGIN/posts/1</link><guid isPermaLink="false">cast-1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered</p>]]></description>
<enclosure url="ORIGIN/ep-good.mp3" length="128" type="audio/mpeg"/>
<itunes:duration>3600</itunes:duration></item>
</channel></rss>`],
    "/cast-bad.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<title>Cast bad</title><link>ORIGIN/</link><description>Bad</description><language>en</language><ttl>60</ttl>
<managingEditor>ana@example.org (Ana Silva)</managingEditor><lastBuildDate>Tue, 15 Sep 2026 10:00:00 +0000</lastBuildDate>
<atom:link rel="self" href="ORIGIN/cast-bad.xml"/><atom:link rel="hub" href="ORIGIN/dead-hub"/>
<itunes:image href="ORIGIN/cover.jpg"/><itunes:category text="Technology"/><itunes:explicit>false</itunes:explicit><itunes:author>Ana</itunes:author>
<podcast:guid>CASTBADGUID</podcast:guid>
<item><title>First post</title><link>ORIGIN/posts/1</link><guid isPermaLink="false">cb-1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered</p>]]></description>
<enclosure url="ORIGIN/ep-length.mp3" length="999999" type="audio/mpeg"/>
<itunes:duration>3600</itunes:duration></item>
<item><title>First post</title><link>ORIGIN/posts/1</link><guid isPermaLink="false">cb-2</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered</p>]]></description>
<enclosure url="ORIGIN/ep-text.mp3" length="9" type="audio/mpeg"/>
<itunes:duration>3600</itunes:duration></item>
<item><title>First post</title><link>ORIGIN/posts/1</link><guid isPermaLink="false">cb-3</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered</p>]]></description>
<enclosure url="ORIGIN/ep-plain.mp3" length="32" type="audio/mpeg"/>
<itunes:duration>3600</itunes:duration></item>
<item><title>First post</title><link>ORIGIN/posts/1</link><guid isPermaLink="false">cb-4</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Rendered</p>]]></description>
<enclosure url="ORIGIN/ep-gone.mp3" length="10" type="audio/mpeg"/>
<itunes:duration>3600</itunes:duration></item>
</channel></rss>`],
    "/ep-good.mp3": [200, { "content-type": "audio/mpeg", "content-length": "128", "accept-ranges": "bytes" }, `ID3${"x".repeat(125)}`],
    "/ep-length.mp3": [200, { "content-type": "audio/mpeg", "content-length": "64", "accept-ranges": "bytes" }, "y".repeat(64)],
    "/ep-text.mp3": [200, { "content-type": "text/plain", "content-length": "9", "accept-ranges": "bytes" }, "not audio"],
    "/ep-plain.mp3": [200, { "content-type": "audio/mpeg", "content-length": "32" }, "z".repeat(32)],
    "/hub": [200, { "content-type": "text/plain" }, "hub"],
    "/summary.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Summary</title><link>ORIGIN/</link><description>Teasers only</description><language>en</language><ttl>60</ttl>
<atom:link rel="self" href="ORIGIN/summary.xml"/>
<item><title>Long one</title><link>ORIGIN/long-1</link><guid isPermaLink="false">sum-1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description>A short teaser of the long article.</description></item>
<item><title>Long two</title><link>ORIGIN/long-2</link><guid isPermaLink="false">sum-2</guid><pubDate>Wed, 02 Sep 2026 10:00:00 GMT</pubDate>
<description>Another short teaser of the other article.</description></item>
</channel></rss>`],
    "/full.xml": [200, { "content-type": RSS, ...POLLED }, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<title>Full</title><link>ORIGIN/</link><description>Everything</description><language>en</language><ttl>60</ttl>
<atom:link rel="self" href="ORIGIN/full.xml"/>
<item><title>Long one</title><link>ORIGIN/long-1</link><guid isPermaLink="false">full-1</guid><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>${"Resilient systems keep working when networks fail and power flickers. ".repeat(30)}</p>]]></description></item>
<item><title>Long two</title><link>ORIGIN/long-2</link><guid isPermaLink="false">full-2</guid><pubDate>Wed, 02 Sep 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>${"Resilient systems keep working when networks fail and power flickers. ".repeat(30)}</p>]]></description></item>
</channel></rss>`],

};

// Serves FILES, anything else as an HTML 404.
export async function serveFeeds(): Promise<FeedSite> {
    let origin = "";
    const good = await sharp({ create: { width: 1400, height: 1400, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const bad = await sharp({ create: { width: 100, height: 50, channels: 3, background: { r: 200, g: 0, b: 0 } } }).png().toBuffer();
    const images: Record<string, [number, Record<string, string>, Buffer]> = {
        "/cover-good.jpg": [200, { "content-type": "image/jpeg" }, good],
        "/cover.jpg": [200, { "content-type": "image/png" }, bad],
    };
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://feeds").pathname;
        const [status, headers, body] = images[pathname] ?? FILES[pathname] ?? [404, { "content-type": HTML } as Record<string, string>, page("en", "Not found", "", "")];
        const text = typeof body === "string" ? body.replaceAll("ORIGIN", () => origin).replaceAll("CASTBADGUID", () => podcastGuid(`${origin}/cast-bad.xml`)).replaceAll("CASTGUID", () => podcastGuid(`${origin}/cast.xml`)) : body;
        if (headers.etag && request.headers["if-none-match"] === headers.etag) response.writeHead(304, headers).end();
        else if (request.method === "HEAD") response.writeHead(status, { date: "Fri, 02 Oct 2026 12:00:00 GMT", ...headers }).end();
        else response.writeHead(status, { date: "Fri, 02 Oct 2026 12:00:00 GMT", ...headers }).end(text);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
