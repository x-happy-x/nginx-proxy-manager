#!/usr/bin/env bash
set -euo pipefail

# Fast deploy: skip npm install, build runtime artifacts, upload runtime-only payload.
# Required env:
#   ROUTER_HOST=192.168.1.1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_INSTALL=1 "${SCRIPT_DIR}/deploy-react-ui.sh" "$@"
