<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Explain a rule

`explain-rule` prints what a rule reads, what it expects and how to fix a finding, with no network.

```console
$ spiderlint explain-rule cookies/host-prefix
cookies/host-prefix
severity warning (preset warning)
score    5.0
scope    page
kind     declarative
rulesets cookies
reads    http.cookies
expect   {"type":"array","items":{"if":{"properties":{"name":{"pattern":"^(?i:__Host-)"}}},"then":{"properties":{"secure":{"const":true},"path":{"const":"/"}},"required":["path"],"not":{"required":["domain"]}}}}
message  a __Host- cookie lacks Secure or Path=/, or sets Domain, so browsers reject it
fix      Add Secure and Path=/, and omit Domain, from every __Host- cookie.
docs     https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie#cookie_prefixes
```
