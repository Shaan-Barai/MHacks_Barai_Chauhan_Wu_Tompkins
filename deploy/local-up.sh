#!/usr/bin/env bash
# Start the local production stack (see deploy/local.sh).
exec "$(dirname "${BASH_SOURCE[0]}")/local.sh" up "$@"
