#!/usr/bin/env bash

# SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
#
# SPDX-License-Identifier: MIT

  # Drop setuid/setgid bits that this stage's packages added, except B19_SETUID_ALLOW
  b19-strip-setuid
