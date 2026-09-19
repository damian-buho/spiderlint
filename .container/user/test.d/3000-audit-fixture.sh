#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# Serves the bundled fixture site and runs a real audit against it, end to end.
set -eou pipefail

# shellcheck source=/dev/null
. b19-i18n

LOG_FILE="$(mktemp)"
REPORT_FILE="$(mktemp)"
# shellcheck disable=SC2329 # cleanup invoked via EXIT trap
cleanup() {
    kill "${SERVER_PID}" 2>/dev/null || true
    rm -f "${LOG_FILE}" "${REPORT_FILE}"
}
trap cleanup EXIT

node --experimental-strip-types "${B19_HOME}/tests/fixtures/serve.ts" > "${LOG_FILE}" 2>&1 &
SERVER_PID=$!

ORIGIN=""
for _ in $(seq 1 50); do
    ORIGIN="$(head -n 1 "${LOG_FILE}")"
    [ -n "${ORIGIN}" ] && break
    sleep 0.1
done
if [ -z "${ORIGIN}" ]; then
    b19-log error "SPIDERLINT" "$(_p "fixture server did not print its origin")"
    exit 1
fi
b19-log info "SPIDERLINT" "$(_p "fixture site: %s" "${ORIGIN}")"

spiderlint audit "${ORIGIN}/" --format json --fail-on never > "${REPORT_FILE}"

PAGES="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).summary.pages)' "${REPORT_FILE}")"
b19-log info "SPIDERLINT" "$(_p "pages crawled: %s" "${PAGES}")"
[ "${PAGES}" -gt 0 ]

BROKEN_LINK="$(node -e '
const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
const finding = report.findings.find((entry) => entry.rule === "links/broken-internal" && entry.url.endsWith("/missing"));
console.log(finding ? finding.message : "");
' "${REPORT_FILE}")"
b19-log info "SPIDERLINT" "$(_p "known dead-link finding: %s" "${BROKEN_LINK}")"
[ -n "${BROKEN_LINK}" ]
