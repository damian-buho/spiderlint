#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: AGPL-3.0-only

# Proves the CLI boots: --help must print the title line.
set -eou pipefail

# shellcheck source=/dev/null
. b19-i18n

TITLE="$(spiderlint --help | head -n 1)"
b19-log info "SPIDERLINT" "$(_p "Title line: %s" "${TITLE}")"
[ -n "${TITLE}" ]
