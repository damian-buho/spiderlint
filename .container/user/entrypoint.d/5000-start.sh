#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Sourced by the b19 entrypoint.d runner; a bare exit would kill the parent shell.

if [ "${ENTRYPOINT_COMMAND_EXECUTED:-N}" = "N" ]; then
    b19-log info "SPIDERLINT" "$(_ "Idle; run spiderlint <url> inside the container")"
    sleep infinity
fi
