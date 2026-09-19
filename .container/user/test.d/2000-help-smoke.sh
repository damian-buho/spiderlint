#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Proves the CLI boots: --help must print the usage line.
set -eou pipefail

# shellcheck source=/dev/null
. b19-i18n

USAGE="$(spiderlint --help | head -n 1)"
b19-log info "SPIDERLINT" "$(_p "Usage line: %s" "${USAGE}")"
[ -n "${USAGE}" ]
