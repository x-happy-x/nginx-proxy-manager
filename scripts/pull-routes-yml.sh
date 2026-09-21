#!/usr/bin/env bash
set -euo pipefail

# Download routes.yml from router using the same connection settings as deploy-react-ui.sh.
# Loads env from DEPLOY_ENV_FILE (default: scripts/deploy-react-ui.env) if present.
# Required env:
#   ROUTER_HOST=192.168.1.1
# Optional env:
#   ROUTER_USER=root
#   ROUTER_PORT=22
#   REMOTE_DIR=/opt/etc/homenet/nginx
#   SSH_OPTS='-o StrictHostKeyChecking=accept-new'
#   ROUTER_PASSWORD='your_password' (requires sshpass)
# Usage:
#   scripts/pull-routes-yml.sh
#   scripts/pull-routes-yml.sh /tmp/router-routes.yml

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEPLOY_ENV_FILE="${DEPLOY_ENV_FILE:-${SCRIPT_DIR}/deploy-react-ui.env}"

if [[ -f "${DEPLOY_ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${DEPLOY_ENV_FILE}"
fi

ROUTER_HOST="${ROUTER_HOST:-}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PORT="${ROUTER_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/etc/homenet/nginx}"
SSH_OPTS="${SSH_OPTS:-}"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"
OUTPUT_PATH="${1:-${REPO_ROOT}/routes.router.yml}"

if [[ -z "${ROUTER_HOST}" ]]; then
  echo "ERROR: ROUTER_HOST is required"
  echo "Example: ROUTER_HOST=192.168.1.1 scripts/pull-routes-yml.sh"
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ERROR: ssh command not found"
  exit 1
fi

SSH_BASE=(ssh -p "${ROUTER_PORT}")
if [[ -n "${SSH_OPTS}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_OPTS=( ${SSH_OPTS} )
  SSH_BASE+=("${EXTRA_OPTS[@]}")
fi

if [[ -n "${ROUTER_PASSWORD}" ]]; then
  if ! command -v sshpass >/dev/null 2>&1; then
    echo "ERROR: ROUTER_PASSWORD is set, but sshpass is not installed"
    exit 1
  fi
  SSH_BASE=(sshpass -p "${ROUTER_PASSWORD}" "${SSH_BASE[@]}")
fi

mkdir -p "$(dirname "${OUTPUT_PATH}")"
"${SSH_BASE[@]}" "${ROUTER_USER}@${ROUTER_HOST}" "cat '${REMOTE_DIR}/routes.yml'" > "${OUTPUT_PATH}"

echo "Downloaded ${ROUTER_USER}@${ROUTER_HOST}:${REMOTE_DIR}/routes.yml -> ${OUTPUT_PATH}"
