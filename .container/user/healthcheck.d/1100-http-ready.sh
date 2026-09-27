#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Sourced under `( . "${CHECK}" )`; only a mode serving the API has a port to probe.

case "${SPIDERLINT_MODE:-cli}" in
    api | all) ;;
    *)
        b19-log debug "SPIDERLINT" "$(_p "healthcheck skipped, mode=%s" "${SPIDERLINT_MODE:-cli}")"
        return 0
        ;;
esac

if ! SPIDERLINT_LOG_LEVEL=silent node --experimental-strip-types "${B19_HOME}/src/server/health.ts"; then
    b19-log warn "SPIDERLINT" "$(_p "healthcheck failed, mode=%s" "${SPIDERLINT_MODE}")"
    return 1
fi
