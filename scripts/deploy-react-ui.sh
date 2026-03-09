#!/usr/bin/env bash
set -euo pipefail

# Build React UI locally and deploy runtime files to router over SSH.
# Loads env from DEPLOY_ENV_FILE (default: scripts/deploy-react-ui.env) if present.
# Required env:
#   ROUTER_HOST=192.168.1.1
# Optional env:
#   ROUTER_USER=root
#   ROUTER_PORT=22
#   REMOTE_DIR=/opt/etc/homenet-nginx
#   SSH_OPTS='-o StrictHostKeyChecking=accept-new'
#   RESTART_UI=1
#   RESTART_CMD='/opt/etc/init.d/S99nginx-manager-lite restart'
#   UPLOAD_APP_ICONS=1
#   SKIP_INSTALL=1
#   ROUTER_PASSWORD='your_password' (requires sshpass)

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
REMOTE_DIR="${REMOTE_DIR:-/opt/etc/homenet-nginx}"
SSH_OPTS="${SSH_OPTS:-}"
RESTART_UI="${RESTART_UI:-0}"
RESTART_CMD="${RESTART_CMD:-/opt/etc/init.d/S99nginx-manager-lite restart}"
UPLOAD_APP_ICONS="${UPLOAD_APP_ICONS:-1}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
ROUTER_PASSWORD="${ROUTER_PASSWORD:-}"

if [[ -z "${ROUTER_HOST}" ]]; then
  echo "ERROR: ROUTER_HOST is required"
  echo "Example: ROUTER_HOST=192.168.1.1 scripts/deploy-react-ui.sh"
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ERROR: ssh command not found"
  exit 1
fi

if ! command -v tar >/dev/null 2>&1; then
  echo "ERROR: tar command not found"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm command not found"
  exit 1
fi

SSH_TARGET="${ROUTER_USER}@${ROUTER_HOST}"
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

echo "[1/5] Install frontend deps"
cd "${REPO_ROOT}/frontend"
if [[ "${SKIP_INSTALL}" == "1" ]]; then
  echo "Skip install (SKIP_INSTALL=1)"
else
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

echo "[2/5] Build frontend"
npm run build

if [[ ! -f "${REPO_ROOT}/frontend/static/react/index.html" ]]; then
  echo "ERROR: build output not found: frontend/static/react/index.html"
  exit 1
fi

echo "[3/5] Ensure remote directories"
"${SSH_BASE[@]}" "${SSH_TARGET}" "mkdir -p '${REMOTE_DIR}/frontend/static/react' '${REMOTE_DIR}/frontend/static/app-icons' '${REMOTE_DIR}/frontend/static/icons'"

echo "[4/5] Upload files"
cd "${REPO_ROOT}"

tar -cf - \
  init.d/S99nginx-manager-lite \
  frontend/static | "${SSH_BASE[@]}" "${SSH_TARGET}" "tar -xf - -C '${REMOTE_DIR}'"

if [[ "${UPLOAD_APP_ICONS}" == "1" && -d "${REPO_ROOT}/frontend/static/app-icons" ]]; then
  tar -cf - frontend/static/app-icons | "${SSH_BASE[@]}" "${SSH_TARGET}" "tar -xf - -C '${REMOTE_DIR}'"
fi

echo "[5/5] Verify remote files"
"${SSH_BASE[@]}" "${SSH_TARGET}" "ls -la '${REMOTE_DIR}/frontend/static/react/index.html' '${REMOTE_DIR}/init.d/S99nginx-manager-lite'"

echo "[5.1/5] Fix init script permissions/links"
"${SSH_BASE[@]}" "${SSH_TARGET}" "chmod +x '${REMOTE_DIR}/init.d/S99nginx-manager-lite' || true; if [ -d /opt/etc/init.d ]; then ln -sf '${REMOTE_DIR}/init.d/S99nginx-manager-lite' /opt/etc/init.d/S99nginx-manager-lite; fi"

if [[ "${RESTART_UI}" == "1" ]]; then
  echo "Restart UI service"
  "${SSH_BASE[@]}" "${SSH_TARGET}" "${RESTART_CMD} || true"
fi

echo "Done: deployed React UI to ${SSH_TARGET}:${REMOTE_DIR}"
