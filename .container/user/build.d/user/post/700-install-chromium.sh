#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Installs the headless shell the pinned playwright launches into PLAYWRIGHT_BROWSERS_PATH.
b19-run "CHROMIUM" "$(_p "Installing chromium headless shell into %s" "${PLAYWRIGHT_BROWSERS_PATH}")" -- \
    npx --no-install playwright install chromium --only-shell || return 1
