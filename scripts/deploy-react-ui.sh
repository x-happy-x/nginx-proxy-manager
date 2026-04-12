#!/usr/bin/env bash
set -euo pipefail

# Build runtime artifacts locally and deploy only required runtime files to router over SSH.
# Loads env from DEPLOY_ENV_FILE (default: scripts/deploy-react-ui.env) if present.
# Required env:
#   ROUTER_HOST=192.168.1.1
# Optional env:
#   ROUTER_USER=root
#   ROUTER_PORT=22
#   REMOTE_DIR=/opt/etc/homenet/nginx
#   BIN_DIR=/opt/bin
#   UI_SOURCE_DIR=frontend
#   SSH_OPTS='-o StrictHostKeyChecking=accept-new'
#   RESTART_UI=1
#   RESTART_CMD='/opt/bin/homenet restart'
#   STOP_BEFORE_UPLOAD=1
#   STOP_CMD='/opt/etc/init.d/S99nginx-manager-lite stop'
#   START_CMD='/opt/bin/homenet start'
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
REMOTE_DIR="${REMOTE_DIR:-/opt/etc/homenet/nginx}"
LEGACY_REMOTE_DIR="${LEGACY_REMOTE_DIR:-/opt/etc/homenet-nginx}"
BIN_DIR="${BIN_DIR:-/opt/bin}"
UI_SOURCE_DIR="${UI_SOURCE_DIR:-frontend}"
SSH_OPTS="${SSH_OPTS:-}"
RESTART_UI="${RESTART_UI:-0}"
RESTART_CMD="${RESTART_CMD:-/opt/etc/init.d/S99nginx-manager-lite restart}"
STOP_BEFORE_UPLOAD="${STOP_BEFORE_UPLOAD:-1}"
STOP_CMD="${STOP_CMD:-/opt/etc/init.d/S99nginx-manager-lite stop}"
START_CMD="${START_CMD:-/opt/bin/homenet start}"
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

if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: go command not found"
  exit 1
fi

UI_SOURCE_PATH="${REPO_ROOT}/${UI_SOURCE_DIR}"
if [[ ! -d "${UI_SOURCE_PATH}" ]]; then
  echo "ERROR: UI source directory not found: ${UI_SOURCE_PATH}"
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

run_ssh() {
  "${SSH_BASE[@]}" "${SSH_TARGET}" "$1"
}

echo "[1/6] Install frontend deps"
cd "${UI_SOURCE_PATH}"
if [[ "${SKIP_INSTALL}" == "1" ]]; then
  echo "Skip install (SKIP_INSTALL=1)"
else
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
fi

echo "[2/6] Build frontend"
npm run build

if [[ ! -f "${REPO_ROOT}/frontend/static/react/index.html" ]]; then
  echo "ERROR: build output not found: frontend/static/react/index.html"
  exit 1
fi

echo "[3/6] Build linux-arm64 binaries"
cd "${REPO_ROOT}/backend"
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/manager ./manager
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/nginx ./nginx
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -o ../bin/linux-arm64/homenet ./ctl

if [[ "${RESTART_UI}" == "1" && "${STOP_BEFORE_UPLOAD}" == "1" ]]; then
  echo "[4/7] Stop UI service before binary update"
  run_ssh "${STOP_CMD} || true"
  run_ssh "i=0; while ps w | grep '${REMOTE_DIR}/bin/linux-arm64/manager' | grep -v grep >/dev/null 2>&1; do i=\$((i + 1)); [ \"\$i\" -ge 30 ] && break; sleep 1; done; ! ps w | grep '${REMOTE_DIR}/bin/linux-arm64/manager' | grep -v grep >/dev/null 2>&1"
else
  echo "[4/7] Skip remote stop"
fi

echo "[5/7] Prepare remote runtime directories"
run_ssh "if [ ! -d '${REMOTE_DIR}' ] && [ -d '${LEGACY_REMOTE_DIR}' ]; then \
  mkdir -p \"\$(dirname '${REMOTE_DIR}')\"; \
  mv '${LEGACY_REMOTE_DIR}' '${REMOTE_DIR}'; \
fi"
run_ssh "mkdir -p '${REMOTE_DIR}/bin/linux-arm64' '${REMOTE_DIR}/frontend/static' '${REMOTE_DIR}/init.d' '${REMOTE_DIR}/config' '${REMOTE_DIR}/.deploy-tmp/config'"
run_ssh "rm -rf \
  '${REMOTE_DIR}/.git' \
  '${REMOTE_DIR}/.idea' \
  '${REMOTE_DIR}/__pycache__' \
  '${REMOTE_DIR}/lite-ui' \
  '${REMOTE_DIR}/screenshots' \
  '${REMOTE_DIR}/static' \
  '${REMOTE_DIR}/backend' \
  '${REMOTE_DIR}/docs' \
  '${REMOTE_DIR}/scripts' \
  '${REMOTE_DIR}/bin/linux-amd64' \
  '${REMOTE_DIR}/frontend/src' \
  '${REMOTE_DIR}/frontend/node_modules' \
  '${REMOTE_DIR}/frontend/static/react' \
  '${REMOTE_DIR}/frontend/static/icons' \
  '${REMOTE_DIR}/frontend/static/app-icons'"
run_ssh "rm -f \
  '${REMOTE_DIR}/AGENTS.md' \
  '${REMOTE_DIR}/README.md' \
  '${REMOTE_DIR}/gen_routes.py' \
  '${REMOTE_DIR}/homenet' \
  '${REMOTE_DIR}/local.setup.sh' \
  '${REMOTE_DIR}/routes.example.yml' \
  '${REMOTE_DIR}/routes.defaults.yml' \
  '${REMOTE_DIR}/frontend/index.html' \
  '${REMOTE_DIR}/frontend-prototype/index.html' \
  '${REMOTE_DIR}/frontend/package.json' \
  '${REMOTE_DIR}/frontend/package-lock.json' \
  '${REMOTE_DIR}/frontend-prototype/package.json' \
  '${REMOTE_DIR}/frontend-prototype/package-lock.json' \
  '${REMOTE_DIR}/frontend/tsconfig.json' \
  '${REMOTE_DIR}/frontend/tsconfig.node.json' \
  '${REMOTE_DIR}/frontend/tsconfig.node.tsbuildinfo' \
  '${REMOTE_DIR}/frontend/tsconfig.tsbuildinfo' \
  '${REMOTE_DIR}/frontend-prototype/tsconfig.json' \
  '${REMOTE_DIR}/frontend-prototype/tsconfig.node.json' \
  '${REMOTE_DIR}/frontend-prototype/tsconfig.tsbuildinfo' \
  '${REMOTE_DIR}/frontend/vite.config.d.ts' \
  '${REMOTE_DIR}/frontend/vite.config.js' \
  '${REMOTE_DIR}/frontend/vite.config.ts' \
  '${REMOTE_DIR}/frontend-prototype/vite.config.ts'"

echo "[6/7] Upload runtime artifacts"
cd "${REPO_ROOT}"

tar -cf - \
  bin/linux-arm64 \
  init.d/S20-nginx-ips \
  init.d/S99nginx-manager-lite \
  frontend/static/react \
  frontend/static/icons | "${SSH_BASE[@]}" "${SSH_TARGET}" "tar -xf - -C '${REMOTE_DIR}'"

if [[ "${UPLOAD_APP_ICONS}" == "1" && -d "${REPO_ROOT}/frontend/static/app-icons" ]]; then
  tar -cf - frontend/static/app-icons | "${SSH_BASE[@]}" "${SSH_TARGET}" "tar -xf - -C '${REMOTE_DIR}'"
fi

tar -cf - routes.yml config/runtime.env | "${SSH_BASE[@]}" "${SSH_TARGET}" "tar -xf - -C '${REMOTE_DIR}/.deploy-tmp'"
run_ssh "if [ ! -f '${REMOTE_DIR}/routes.yml' ]; then cp '${REMOTE_DIR}/.deploy-tmp/routes.yml' '${REMOTE_DIR}/routes.yml'; fi"
run_ssh "if [ ! -f '${REMOTE_DIR}/config/runtime.env' ]; then cp '${REMOTE_DIR}/.deploy-tmp/config/runtime.env' '${REMOTE_DIR}/config/runtime.env'; fi"
run_ssh "if [ -f '${REMOTE_DIR}/config/runtime.env' ]; then \
  sed -i 's#/opt/etc/homenet-nginx#/opt/etc/homenet/nginx#g' '${REMOTE_DIR}/config/runtime.env'; \
fi"
run_ssh "rm -rf '${REMOTE_DIR}/.deploy-tmp'"

echo "[7/7] Verify remote runtime and restart"
run_ssh "chmod +x \
  '${REMOTE_DIR}/init.d/S20-nginx-ips' \
  '${REMOTE_DIR}/init.d/S99nginx-manager-lite' \
  '${REMOTE_DIR}/bin/linux-arm64/manager' \
  '${REMOTE_DIR}/bin/linux-arm64/nginx' \
  '${REMOTE_DIR}/bin/linux-arm64/homenet'"
run_ssh "if [ -d '${BIN_DIR}' ]; then \
  cp -f '${REMOTE_DIR}/bin/linux-arm64/homenet' '${BIN_DIR}/homenet'; \
  chmod 755 '${BIN_DIR}/homenet'; \
fi"
run_ssh "if [ -d /opt/etc/init.d ]; then \
  cp -f '${REMOTE_DIR}/init.d/S20-nginx-ips' /opt/etc/init.d/S20-nginx-ips; \
  chmod 755 /opt/etc/init.d/S20-nginx-ips; \
  cp -f '${REMOTE_DIR}/init.d/S99nginx-manager-lite' /opt/etc/init.d/S99nginx-manager-lite; \
  chmod 755 /opt/etc/init.d/S99nginx-manager-lite; \
fi"
run_ssh "ls -la \
  '${BIN_DIR}/homenet' \
  '${REMOTE_DIR}/frontend/static/react/index.html' \
  '${REMOTE_DIR}/frontend/static/icons/menu.svg' \
  '${REMOTE_DIR}/bin/linux-arm64/manager' \
  '${REMOTE_DIR}/routes.yml' \
  '${REMOTE_DIR}/config/runtime.env'"

if [[ "${RESTART_UI}" == "1" ]]; then
  echo "Restart UI service"
  if [[ "${STOP_BEFORE_UPLOAD}" == "1" ]]; then
    run_ssh "${START_CMD}"
  else
    run_ssh "${RESTART_CMD}"
  fi
fi

echo "Done: deployed runtime artifacts to ${SSH_TARGET}:${REMOTE_DIR}"
