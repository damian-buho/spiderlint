#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# test.d/ scripts run as a subprocess via b19-run, so they source b19-i18n themselves.
set -eou pipefail

# shellcheck source=/dev/null
. b19-i18n

NODE_VERSION="$(node --version)"
b19-log info "SPIDERLINT" "$(_p "Node runtime version: %s" "${NODE_VERSION}")"

PKG_VERSION="$(get-spiderlint-version)"
b19-log info "SPIDERLINT" "$(_p "Tool version: %s" "${PKG_VERSION}")"
