#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

# test.d/ scripts run as a subprocess via b19-run, so they source b19-i18n themselves.
set -eou pipefail

# shellcheck source=/dev/null
. b19-i18n

if [ -z "${SPIDERLINT_TEST_VALKEY:-}" ]; then
    b19-log info "SPIDERLINT" "$(_ "Server check skipped: SPIDERLINT_TEST_VALKEY is unset")"
    exit 0
fi

PORT=18181
BASE="http://127.0.0.1:${PORT}"
PASSWORD_FILE=/run/secrets/o9s.vlky.password
WORK="$(mktemp --directory)"
PIDS=()

# shellcheck disable=SC2329 # cleanup invoked via EXIT trap
cleanup() {
    kill "${PIDS[@]}" 2>/dev/null || true
    rm --recursive --force "${WORK}"
}
trap cleanup EXIT

# The bundled fixture site, its origin read from its first line.
node --experimental-strip-types "${B19_HOME}/tests/fixtures/serve.ts" >"${WORK}/fixture" 2>/dev/null &
PIDS+=("$!")

cat >"${WORK}/server.yaml" <<EOF
redis: redis://${SPIDERLINT_TEST_VALKEY}/0
$([ -r "${PASSWORD_FILE}" ] && echo "redis-password-file: ${PASSWORD_FILE}")
listen: { host: 127.0.0.1, port: ${PORT} }
allow-private: true
clients: { rate: false }
policies:
  - name: selftest
    hosts: ["*"]
    caps: { max-pages: 5 }
EOF

(cd "${WORK}" && SPIDERLINT_SERVER_CONFIG="${WORK}/server.yaml" SPIDERLINT_MODE=all SPIDERLINT_LOG_FORMAT=json \
    exec node --experimental-strip-types "${B19_HOME}/src/server/main.ts" >"${WORK}/server.log" 2>&1) &
PIDS+=("$!")

for attempt in $(seq 1 30); do
    ORIGIN="$(head --lines=1 "${WORK}/fixture" 2>/dev/null || true)"
    if [ -n "${ORIGIN}" ] && curl --silent --fail --max-time 2 --output /dev/null "${BASE}/healthz"; then break; fi
    b19-log debug "SPIDERLINT" "$(_p "Waiting for the server, attempt %s" "${attempt}")"
    sleep 1
done
if ! curl --silent --fail --max-time 2 --output /dev/null "${BASE}/healthz"; then
    b19-log error "SPIDERLINT" "$(_p "The server did not answer /healthz: %s" "$(tail --lines=5 "${WORK}/server.log")")"
    exit 1
fi

# Submit the form as a browser does; the answer is a redirect to the job page.
JOB_PAGE="$(curl --silent --max-time 10 --output /dev/null --write-out '%{redirect_url}' --data-urlencode "url=${ORIGIN}/" "${BASE}/")"
JOB_ID="${JOB_PAGE##*/jobs/}"
if [ -z "${JOB_PAGE}" ] || [ "${JOB_ID}" = "${JOB_PAGE}" ]; then
    b19-log error "SPIDERLINT" "$(_p "The form did not redirect to a job: %s" "${JOB_PAGE}")"
    exit 1
fi
b19-log info "SPIDERLINT" "$(_p "Form queued job %s" "${JOB_ID}")"

STATUS=queued
for attempt in $(seq 1 60); do
    STATUS="$(curl --silent --max-time 5 "${BASE}/v1/jobs/${JOB_ID}" | node --eval 'let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => console.log(JSON.parse(s).status))')"
    b19-log debug "SPIDERLINT" "$(_p "Job %s is %s, attempt %s" "${JOB_ID}" "${STATUS}" "${attempt}")"
    case "${STATUS}" in done | failed) break ;; esac
    sleep 2
done
if [ "${STATUS}" != "done" ]; then
    b19-log error "SPIDERLINT" "$(_p "Job %s ended as %s" "${JOB_ID}" "${STATUS}")"
    exit 1
fi

# The report page and the badge both name the job.
PAGE="$(curl --silent --max-time 10 --header 'accept-language: uk' "${BASE}/jobs/${JOB_ID}")"
if ! grep --quiet --fixed-strings 'lang="uk"' <<<"${PAGE}" || ! grep --quiet --fixed-strings "/v1/jobs/${JOB_ID}/report/html" <<<"${PAGE}"; then
    b19-log error "SPIDERLINT" "$(_p "The report page of job %s is incomplete" "${JOB_ID}")"
    exit 1
fi
HOST="$(node --eval 'console.log(new URL(process.argv[1]).hostname)' "${ORIGIN}")"
for attempt in $(seq 1 10); do
    if curl --silent --max-time 5 "${BASE}/badge/${HOST}.svg" | grep --quiet --fixed-strings "/jobs/${JOB_ID}"; then
        b19-log info "SPIDERLINT" "$(_p "Server check passed: job %s, report page and badge" "${JOB_ID}")"
        exit 0
    fi
    b19-log debug "SPIDERLINT" "$(_p "Badge of %s not updated yet, attempt %s" "${HOST}" "${attempt}")"
    sleep 1
done
b19-log error "SPIDERLINT" "$(_p "The badge of %s does not link job %s" "${HOST}" "${JOB_ID}")"
exit 1
