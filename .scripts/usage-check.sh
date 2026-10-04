#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Checks docs/usage.d against src/cli.ts directly, with no image build; it is also the container runtime shim usage-capture.sh calls.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "run" ]]; then
    shift
    env_pairs=()
    lang=en
    # Collect the `--env NAME=value` pairs the capture passes before the image name.
    while [[ "${1:-}" == "--rm" || "${1:-}" == "--env" ]]; do
        if [[ "$1" == "--env" ]]; then
            env_pairs+=("$2")
            [[ "$2" == USAGE_LANG=* ]] && lang="${2#USAGE_LANG=}"
            shift
        fi
        shift
    done
    # Drop the image name and the `sh -c <script> sh` wrapper, leaving the command and its arguments.
    shift 5
    printf 'usage-check: source help lang=%s args=%s\n' "${lang}" "${*:2}" >&2
    exec env --unset=XDG_CACHE_HOME HOME=/app "${env_pairs[@]}" LC_ALL="${lang}" LANGUAGE="${lang}" "${root}/bin/spiderlint.js" "${@:2}" --help 2>&1
fi

cd "${root}"
mode=--check
# `--capture` rewrites docs/usage.d instead of checking it.
[[ "${1:-}" == "--capture" ]] && mode=""
printf 'usage-check: mode=%s\n' "${mode:-capture}" >&2
M6E_CONTAINER_RUNTIME="${root}/.scripts/usage-check.sh" M6E_IMAGE_FULLNAME="source:src/cli.ts" "${root}/.makefile/container/scripts/usage-capture.sh" ${mode}
