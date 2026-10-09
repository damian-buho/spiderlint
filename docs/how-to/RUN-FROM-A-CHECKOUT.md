<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Run spiderlint from a checkout

The container and a packed install both provide a `spiderlint` command. In a checkout, `bin/spiderlint.js` is that command: it runs `dist/cli.js` when a build exists and the TypeScript sources in `src/` otherwise.

## Link the checkout

```sh
npm install
npm link
spiderlint --version
```

- `npm link` symlinks the checkout into the global prefix. Node resolves the real path, which lies outside `node_modules`, so the sources run and every edit applies at once.
- `npm unlink --global dbuho-spiderlint` removes the link.

## Install a packed build

```sh
npm pack
npm install --global ./dbuho-spiderlint-*.tgz
```

- `prepack` compiles `src/` into `dist/` with `tsconfig.build.json`, and `postpack` deletes `dist/` again, so a checkout never keeps a stale build.
- Node refuses to strip types for files under `node_modules`, which is why a package ships the build instead of the sources.
