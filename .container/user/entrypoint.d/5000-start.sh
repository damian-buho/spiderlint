#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: AGPL-3.0-only

# Sourced by the b19 entrypoint.d runner; a bare exit would kill the parent shell.

if [ "${ENTRYPOINT_COMMAND_EXECUTED:-N}" = "N" ]; then
    case "${SPIDERLINT_MODE:-cli}" in
        api | worker | all)
            if [ "${APP_ENV:-}" = "development" ]; then
                b19-log info "SPIDERLINT" "$(_p "Starting the server, restarted on a source change (mode=%s)" "${SPIDERLINT_MODE}")"
                exec node --watch-path="${B19_HOME}/src" --watch-path="${B19_HOME}/locales" --watch-path="${B19_HOME}/presets" --watch-path=/etc/spiderlint --watch-preserve-output --experimental-strip-types "${B19_HOME}/src/server/main.ts"
            fi
            b19-log info "SPIDERLINT" "$(_p "Starting the server (mode=%s)" "${SPIDERLINT_MODE}")"
            exec node --experimental-strip-types "${B19_HOME}/src/server/main.ts"
            ;;
    esac
    b19-log info "SPIDERLINT" "$(_ "Idle; run spiderlint <url> inside the container")"
    sleep infinity
fi
