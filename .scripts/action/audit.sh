#!/usr/bin/env bash
# shellcheck disable=SC2154 # RUNNER_TEMP, GITHUB_* and the inputs come from the runner and action.yaml
# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Crawls once into a runner-side store, then renders human and SARIF from it without the network.
set -euo pipefail

stem="spiderlint-report${SITE:+-${SITE//[^A-Za-z0-9._-]/_}}"
report_json="${RUNNER_TEMP}/${stem}.json"
report_sarif="${RUNNER_TEMP}/${stem}.sarif"
cache="${RUNNER_TEMP}/spiderlint-cache"
mkdir --parents "${cache}"
# The container user differs from the runner's; the store keeps its own owner-only modes inside.
chmod 0777 "${cache}"

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
if [ -n "${RULES}" ]; then
    args+=(--rules "${RULES}")
fi
echo "Seeds: ${#args[@]} argument(s), site=${SITE:-all}, fail_on=${FAIL_ON}, image=${IMAGE}"

if ! docker pull --quiet "${IMAGE}"; then
    echo "::warning::pull failed, trying a local ${IMAGE}"
fi

docker_run=(run --rm --network host
    --env XDG_CACHE_HOME=/cache
    --volume "${cache}:/cache"
    --volume "${GITHUB_WORKSPACE}:/src:ro"
    --workdir /src
    "${IMAGE}" spiderlint)

exit_code=0
echo "::group::spiderlint audit"
docker "${docker_run[@]}" audit "${args[@]}" --format json --fail-on "${FAIL_ON}" > "${report_json}" || exit_code=$?
echo "::endgroup::"
echo "Audit exit code: ${exit_code}"
if [ "${exit_code}" -gt 1 ]; then
    echo "::error::spiderlint failed with exit code ${exit_code}"
    exit "${exit_code}"
fi

docker "${docker_run[@]}" report "${args[@]}" --format sarif --fail-on never > "${report_sarif}"
{
    echo '```text'
    docker "${docker_run[@]}" report "${args[@]}" --format human --no-color --fail-on never
    echo '```'
} >> "${GITHUB_STEP_SUMMARY}"

{
    echo "exit_code=${exit_code}"
    echo "report_json=${report_json}"
    echo "sarif_path=${report_sarif}"
} >> "${GITHUB_OUTPUT}"
