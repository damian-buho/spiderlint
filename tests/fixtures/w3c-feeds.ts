// SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
//
// SPDX-License-Identifier: MIT

// A sample of the W3C Feed Validation Service corpus
// (github.com/w3c/feedvalidator, `testcases/`), one small feed per message
// with the expected message in a comment. Bodies are verbatim; only the
// `Expect:` line decides the spiderlint rule each case asserts. The corpus is
// MIT-style licenced (Copyright 2002–2006 Sam Ruby, Mark Pilgrim, Joseph
// Walton, Phil Ringnalda); the full corpus holds 2000+ files, most of them
// date and email permutations, so this file keeps one case per message the
// `feeds` preset judges, and `tests/w3c-feeds.test.ts` names the rest as
// uncovered instead of skipping them silently. Never shell out to the validator.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface W3CCase {
    path: string;
    type: string;
    // The `testcases/` path the body is verbatim from.
    source: string;
    // The validator’s message, from the body's `Expect:` comment.
    expects: string;
    // The `feeds/*` rule that must fire for it, absent when uncovered.
    rule?: string;
    body: string;
}

const RSS = "application/rss+xml; charset=utf-8";
const ATOM = "application/atom+xml";

// Bodies below are verbatim from the validator; their `http://` URLs are the corpus’s own.
/* eslint-disable unicorn/prefer-https -- vendored W3C bodies name http:// example URLs */
export const W3C_CASES: W3CCase[] = [
    {
        path: "/guid-duplicate.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-item-guid/guid_duplicate_value.xml",
        expects: "DuplicateValue{element:guid}",
        rule: "feeds/duplicate-id",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  guid value must be unique within a feed
  Expect:       DuplicateValue{element:guid}
-->

<rss version="2.0">
<channel>
<title>Invalid GUID</title>
<link>http://purl.org/rss/2.0/</link>
<description>foo</description>
<item>
<title>foo</title>
<guid>http://example.com/weblog/123</guid>
</item>
<item>
<title>bar</title>
<guid>http://example.com/weblog/123</guid>
</item>
</channel>
</rss>`,
    },
    {
        path: "/guid-missing.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-item-guid/missing_guid.xml",
        expects: "MissingGuid",
        rule: "feeds/item-id",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  guid is missing
  Expect:       MissingGuid
-->

<rss version="2.0">
<channel>
<title>Missing GUID</title>
<link>http://purl.org/rss/2.0/</link>
<description>foo</description>
<item>
<title>Missing GUID</title>
</item>
</channel>
</rss>`,
    },
    {
        path: "/guid-invalid.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-item-guid/invalid_guid_value.xml",
        expects: "InvalidHttpGUID{parent:item,element:guid}",
        rule: "feeds/permalink",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  guid must be http URL
  Expect:       InvalidHttpGUID{parent:item,element:guid}
-->

<rss version="2.0">
<channel>
<title>Invalid GUID</title>
<link>http://purl.org/rss/2.0/</link>
<description>foo</description>
<item>
<title>Invalid GUID</title>
<guid>example.com</guid>
</item>
</channel>
</rss>`,
    },
    {
        path: "/language-invalid.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-language/invalid_language.xml",
        expects: "InvalidLanguage{parent:channel,element:language}",
        rule: "feeds/language",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  language must be ISO-639 language code
  Expect:       InvalidLanguage{parent:channel,element:language}
-->

<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Validity test</title>
<link>http://purl.org/rss/2.0/</link>
<description>invalid language</description>
<language>English</language>
</channel>
</rss>`,
    },
    {
        path: "/editor-invalid.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-managingeditor/invalid_managingEditor.xml",
        expects: "InvalidContact{parent:channel,element:managingEditor}",
        rule: "feeds/email",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  managingEditor must include email address
  Expect:       InvalidContact{parent:channel,element:managingEditor}
-->

<rss version="2.0">
<channel>
<title>Invalid webMaster</title>
<link>http://purl.org/rss/2.0/</link>
<description>managingEditor must include email address</description>
<managingEditor>Mark Pilgrim</managingEditor>
</channel>
</rss>`,
    },
    {
        path: "/link-invalid.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-link/invalid_link.xml",
        expects: "InvalidLink{parent:channel,element:link}",
        rule: "feeds/absolute-url",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  channel link must be full URL, including protocol
  Expect:       InvalidLink{parent:channel,element:link}
-->

<rss version="2.0">
<channel>
<title>Invalid link</title>
<link>purl.org/rss/2.0/</link>
<description>channel link must be full URL, including protocol</description>
</channel>
</rss>`,
    },
    {
        path: "/pubdate-invalid.xml",
        type: RSS,
        source: "testcases/rss20/data-types-datetime/invalid_pubdate.xml",
        expects: "InvalidRFC2822Date{parent:channel,element:pubDate}",
        rule: "feeds/date-format",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  pubDate must be RFC 2822 date format
  Expect:       InvalidRFC2822Date{parent:channel,element:pubDate}
-->

<rss version="2.0">
<channel>
<title>Invalid date format</title>
<link>http://purl.org/rss/2.0/</link>
<description>pubDate must be RFC 2822 date format</description>
<pubDate>2002-12-31T01:15:07-05:00</pubDate>
</channel>
</rss>`,
    },
    {
        path: "/pubdate-weekday.xml",
        type: RSS,
        source: "testcases/rss20/data-types-datetime/invalid_pubdate_dow.xml",
        expects: "InvalidRFC2822Date{parent:channel,element:pubDate}",
        rule: "feeds/date-format",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  Wrong Day of Week
  Expect:       InvalidRFC2822Date{parent:channel,element:pubDate}
-->

<rss version="2.0">
<channel>
<title>Invalid date format</title>
<link>http://purl.org/rss/2.0/</link>
<description>pubDate must be RFC 2822 date format</description>
<pubDate>Thu, 19 Jul 2006 23:08:26 +1000</pubDate>
</channel>
</rss>`,
    },
    {
        path: "/email-jumbled.xml",
        type: RSS,
        source: "testcases/rss20/data-types-email/jumbled.xml",
        expects: "EmailFormat",
        rule: "feeds/email",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  all the right information in the wrong order
  Expect:       EmailFormat
-->

<rss version="2.0">
<channel>
 <title>3.3 E-mail Addresses</title>
 <description>The recommended format for e-mail addresses in RSS elements is username@hostname.tld (Real Name)</description>
 <link>http://www.rssboard.org/rss-profile#data-types-email</link>
 <item>
  <description>The recommended format for e-mail addresses in RSS elements is username@hostname.tld (Real Name)</description>
  <author>John Smith, jsmith@example.org</author>
 </item>
</channel>
</rss>`,
    },
    {
        path: "/title-html.xml",
        type: RSS,
        source: "testcases/rss20/element-channel-title/invalid_title.xml",
        expects: "ContainsHTML{parent:channel,element:title}",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2002 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  channel title must not include HTML
  Expect:       ContainsHTML{parent:channel,element:title}
-->

<rss version="2.0">
<channel>
<title>&lt;b&gt;Invalid title&lt;/b&gt;</title>
<link>http://purl.org/rss/2.0/</link>
<description>channel title must not include HTML</description>
</channel>
</rss>`,
    },
    {
        path: "/atom-authorless.xml",
        type: ATOM,
        source: "testcases/atom/4.1.1/authorless-with-one-entry.xml",
        expects: "MissingElement{element:author,parent:entry}",
        rule: "feeds/required",
        body: `<?xml version="1.0" encoding="utf-8"?>
<!--
Author:       Sam Ruby <rubys@intertwingly.net>
-->

<!--
Description:  a feed with one entry, neither of which contains an atom:author element
Expect:       MissingElement{element:author,parent:entry}
-->

<feed xmlns="http://www.w3.org/2005/Atom">

  <title>Example Feed</title>
  <link href="http://example.org/"/>
  <updated>2003-12-13T18:30:02Z</updated>
  <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>

  <entry>
    <title>Atom-Powered Robots Run Amok</title>
    <link href="http://example.org/2003/12/13/atom03"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2003-12-13T18:30:02Z</updated>
    <summary>Some text.</summary>
  </entry>

</feed>`,
    },
    {
        path: "/atom-updated.xml",
        type: ATOM,
        source: "testcases/atom/must/feed_modified_wrong_format.xml",
        expects: "InvalidRFC3339Date{parent:feed,element:updated}",
        rule: "feeds/date-format",
        body: `<!--
  Author:       Sam Ruby (http://intertwingly.net/) and Mark Pilgrim (http://diveintomark.org/)
  Copyright:    Copyright (c) 2003 Sam Ruby and Mark Pilgrim
-->

<!--
  Description:  modified must be W3CDTF date format
  Expect:       InvalidRFC3339Date{parent:feed,element:updated}
-->

<feed xmlns="http://www.w3.org/2005/Atom">
<updated>Mon, 31 Dec 2002 14:20:20 GMT</updated>
</feed>`,
    },
];

// Serves every W3C case under its path and an index linking them all.
export async function serveW3C(): Promise<{ origin: string; close(): Promise<void> }> {
    const server: Server = createServer((request, response) => {
        const pathname = new URL(request.url ?? "/", "http://w3c").pathname;
        const found = W3C_CASES.find((entry) => entry.path === pathname);
        if (!found) {
            const links = W3C_CASES.map((entry) => `<a href="${entry.path}">${entry.path}</a>`).join(" ");
            response.writeHead(200, { "content-type": "text/html; charset=utf-8", date: "Fri, 02 Oct 2026 12:00:00 GMT" }).end(`<!DOCTYPE html><html lang="en"><head><title>W3C cases</title></head><body><h1>W3C cases</h1>${links}</body></html>`);
            return;
        }
        response.writeHead(200, { "content-type": found.type, date: "Fri, 02 Oct 2026 12:00:00 GMT" }).end(found.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
