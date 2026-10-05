<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Поясніть правило

`explain-rule` показує, що правило читає, чого очікує і як виправити знахідку, без мережі.

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
