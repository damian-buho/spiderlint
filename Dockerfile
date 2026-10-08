# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

ARG B19_NODE_BASE_IMAGE=registry.invalid/b19/node:n26
ARG PF_CLI_IMAGE=registry.invalid/projectfile/cli:latest

FROM ${PF_CLI_IMAGE} AS pf-cli

FROM ${B19_NODE_BASE_IMAGE} AS spiderlint

ARG B19_COLOR
ARG B19_FETCH_DOCKER_CACHE
ARG B19_FETCH_LOCAL_CACHE
ARG B19_OFFGRID_MODE
ARG B19_VERBOSITY
ARG LANG=""
ARG M6E_AI=N
ARG M6E_APT_CACHE_HOST=""
ARG M6E_APT_CACHE_PORT=""
ARG M6E_BUILD_DEBUG=""
ARG M6E_NAMESPACE
ARG M6E_NEAR_CACHE_HOST=""
ARG M6E_PROJECT
ARG TARGETARCH

ENV NODE_ENV=production                                  \
    NODE_OPTIONS="--enable-source-maps"                  \
    SPIDERLINT_LOG_LEVEL=warn                            \
    SPIDERLINT_MODE=cli

COPY --chown=${B19_UID}:${B19_GID} .container/root/ /
# Reads the org.spiderlint subtree of a mounted projectfile
COPY --from=pf-cli /usr/local/bin/pf-cli /usr/local/bin/pf-cli

USER 0

WORKDIR ${B19_HOME}

RUN --mount=type=bind,from=fetch,source=.,target=/fetch                                           \
    --mount=type=cache,target=${B19_DOWNLOAD_PATH},sharing=shared                                 \
    --mount=type=cache,id=apt-cache-${B19_UBUNTU_SERIES}-${TARGETARCH},target=/var/cache/apt,sharing=shared     \
    --mount=type=cache,id=apt-lists-${B19_UBUNTU_SERIES}-${TARGETARCH},target=/var/lib/apt,sharing=shared       \
    --mount=type=tmpfs,target=${B19_TEMP_PATH}                                                    \
    build-stage root

# hadolint ignore=DL3066 # B19_UID comes from the root
USER ${B19_UID}

COPY --chown=${B19_UID}:${B19_GID} .container/user/ /
COPY --chown=${B19_UID}:${B19_GID} package.json package-lock.json tsconfig.json ${B19_HOME}/
COPY --chown=${B19_UID}:${B19_GID} src/                                       ${B19_HOME}/src/
COPY --chown=${B19_UID}:${B19_GID} presets/                                   ${B19_HOME}/presets/
COPY --chown=${B19_UID}:${B19_GID} vendors/                                   ${B19_HOME}/vendors/
COPY --chown=${B19_UID}:${B19_GID} locales/                                   ${B19_HOME}/locales/
COPY --chown=${B19_UID}:${B19_GID} tests/fixtures/                            ${B19_HOME}/tests/fixtures/

ARG M6E_VERSION
RUN --mount=type=bind,from=fetch,source=.,target=/fetch                                               \
    --mount=type=cache,target=${B19_DOWNLOAD_PATH},sharing=shared,uid=${B19_UID},gid=${B19_GID}       \
    --mount=type=cache,target=${B19_NODE_NPM_CACHE},sharing=locked,uid=${B19_UID},gid=${B19_GID}      \
    --mount=type=tmpfs,target=${B19_TEMP_PATH}                                                        \
    build-stage user

# The API port under SPIDERLINT_MODE=api or all, as the server settings’ default names it
EXPOSE 8080

# ENTRYPOINT ["entrypoint.d"] is inherited
# HEALTHCHECK CMD ["healthcheck.d"] is inherited
