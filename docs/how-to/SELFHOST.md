<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Self-host the scan server

The image that runs the command line also runs the web form, the API and the scan workers. One container plus a Valkey (or Redis) is a complete instance, and you decide which sites it may scan, how often and how deeply.

## What you need

- A host with Docker and Compose. The image is `amd64` only.
- A Valkey or Redis the server can reach, kept behind a password.
- A reverse proxy for TLS, if the instance is public.

## Start it

Put the settings in `server.yaml`:

```yaml
redis: redis://valkey:6379/0
redis-password-file: /run/secrets/o9s.vlky.password
recent: 10
policies:
  - name: everyone
    hosts: ["*"]
    rate: { jobs: 10, per: 1h }
    repeat: 30m
    caps: { max-pages: 100 }
```

Then run both containers:

```yaml
services:
  valkey:
    image: kiota.ch/o9s/valkey:latest
    environment: { O9S_VLKY_SAVE: "" }
    secrets: [o9s.vlky.password]
  spiderlint:
    image: kiota.ch/damian-buho/spiderlint:latest
    environment: { SPIDERLINT_MODE: all }
    ports: ["127.0.0.1:8080:8080"]
    secrets: [o9s.vlky.password]
    volumes: [./server.yaml:/etc/spiderlint/server.yaml:ro]
secrets:
  o9s.vlky.password:
    file: ./valkey.password
```

```sh
docker compose up --detach
```

The form is at `http://127.0.0.1:8080/`, the API under `/v1/` and a health check at `/healthz`.

## Open it to the public

- Terminate TLS in the proxy and list its network under `clients.trusted-proxies`, so the per-client limit sees the visitor and not the proxy.
- Keep `allow-private: false`, the default: scans then refuse loopback and private addresses, and only the `http` fetch mode is on.
- Ban what you do not want scanned with a policy `ban`, and slow a host down with `rate` and `repeat`.
- Change `SPIDERLINT_MODE` to `api` on one container and `worker` on others to scale scans apart from the pages.

The settings file is read again every 5 seconds, so a valid edit applies without a restart. Every setting, route and the page customisation options are described in the [scan server reference](server.md).
