#!/usr/bin/env bash
# Stop only what deploy/local-up.sh started (see deploy/local.sh).
exec "$(dirname "${BASH_SOURCE[0]}")/local.sh" down "$@"
