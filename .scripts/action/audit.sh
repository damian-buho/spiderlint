#!/usr/bin/env bash
# shellcheck disable=SC2154 # RUNNER_TEMP, GITHUB_* and the inputs come from the runner and action.yaml
# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: AGPL-3.0-only

# Crawls once into a runner-side store, then renders human and SARIF from it without the network.
set -euo pipefail

stem="spiderlint-report${SITE:+-${SITE//[^A-Za-z0-9._-]/_}}"
report_json="${RUNNER_TEMP}/${stem}.json"
report_sarif="${RUNNER_TEMP}/${stem}.sarif"
cache="${RUNNER_TEMP}/spiderlint-cache"
mkdir --parents "${cache}"

# An action used at a version tag pulls the image of that tag.
if [ -z "${VERSION}" ] && [[ "${ACTION_REF}" =~ ^v?([0-9]+(\.[0-9]+){0,2})$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
fi
IMAGE="${IMAGE:-ghcr.io/damian-buho/spiderlint:${VERSION:-latest}}"

args=()
while IFS= read -r url; do
    if [ -n "${url}" ]; then
        args+=("${url}")
    fi
done <<< "${URLS}"
if [ -n "${CONFIG_FILE}" ]; then
    args+=(--config "${CONFIG_FILE}")
fi
if [ -n "${SITE}" ]; then
    args+=(--site "${SITE}")
fi
audit_args=()
if [ -n "${RULES}" ]; then
    audit_args+=(--rules "${RULES}")
fi
# One flag per line, split at its first space into the flag and its value.
while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    if [ -z "${line}" ]; then
        continue
    fi
    echo "Extra argument: ${line}"
    if [[ "${line}" == *" "* ]]; then
        audit_args+=("${line%% *}" "${line#* }")
    else
        audit_args+=("${line}")
    fi
done <<< "${EXTRA_ARGS}"
echo "Targets: ${#args[@]} argument(s), extra: ${#audit_args[@]}, site=${SITE:-all}, fail_on=${FAIL_ON}, image=${IMAGE}"

if ! docker pull --quiet "${IMAGE}"; then
    echo "::warning::pull failed, trying a local ${IMAGE}"
fi

# The runner's uid owns the store so the cache step can save it; gid 0 may write the image's home.
docker_run=(run --rm --network host --user "$(id --user):0"
    --env XDG_CACHE_HOME=/cache
    --volume "${cache}:/cache"
    --volume "${GITHUB_WORKSPACE}:/src:ro"
    --workdir /src
    "${IMAGE}" spiderlint)

exit_code=0
echo "::group::spiderlint audit"
docker "${docker_run[@]}" audit "${args[@]}" "${audit_args[@]}" --format json --fail-on "${FAIL_ON}" > "${report_json}" || exit_code=$?
echo "::endgroup::"
echo "Audit exit code: ${exit_code}"
if [ "${exit_code}" -gt 1 ]; then
    echo "::error::spiderlint failed with exit code ${exit_code}"
    exit "${exit_code}"
fi

docker "${docker_run[@]}" show-report "${args[@]}" --format sarif --fail-on never > "${report_sarif}"
{
    echo '```text'
    docker "${docker_run[@]}" show-report "${args[@]}" --format human --no-color --fail-on never
    echo '```'
} >> "${GITHUB_STEP_SUMMARY}"

{
    echo "exit_code=${exit_code}"
    echo "report_json=${report_json}"
    echo "sarif_path=${report_sarif}"
} >> "${GITHUB_OUTPUT}"
